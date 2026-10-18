// src/lib/chat/withAssistantReceipt.ts

// Adaptador de servidor que añade un recibo firmado a las respuestas de las rutas
// /api/plans/*/assistant (riesgo R1). Envuelve el handler de la ruta:
//
//   export const POST = withAssistantReceipt(handlePost, assistantReceiptServerDeps);
//
// Solo firma cuando se cumple TODO lo siguiente; si algo falla, devuelve la misma respuesta
// del handler, intacta y sin recibo:
//   1. el handler respondió 2xx, JSON y ok: true;
//   2. hay un assistantMessage de texto no vacío en data.assistantMessage o, si no, en
//      assistantMessage (forma de final_doc);
//   3. la clave está disponible (ASSISTANT_RECEIPT_SECRET válido);
//   4. el usuario sale de la sesión del servidor (deps.authenticate, requireUser en producción);
//   5. el cuerpo de la petición trae un chatId UUID y ese chat es del usuario
//      (deps.isChatOwner, assertChatOwner en producción);
//   6. el texto no es una copia exacta de ningún texto que el cliente envió en la petición.
// El recibo se firma sobre el assistantMessage exacto de la respuesta, nunca sobre algo que
// venga del navegador, y se añade como `assistantReceipt` junto a ese assistantMessage. El
// resto del cuerpo, el estado y las cabeceras no cambian (salvo content-length, que se
// recalcula). Las respuestas de error nunca se tocan.
//
// Lo que NO hace: decidir qué se guarda en messages, impedir que un recibo válido se use dos
// veces ni representar el historial. Eso queda para /api/messages y aún no tiene diseño
// cerrado: generar recibos no resuelve R1 por sí solo.
//
// Coste al activarlo: una llamada más a requireUser y una consulta de chats por respuesta
// firmada, y una copia del cuerpo de la petición (clone) para leer chatId.
//
// Sin dependencias de Supabase ni de process.env: todo llega por deps, así se prueba sin red.

import { z } from "zod";

import { signAssistantReceipt } from "@/lib/chat/assistantReceipt";
import type { AssistantReceiptKeyStatus } from "@/lib/chat/assistantReceiptConfig";

export const ASSISTANT_RECEIPT_FIELD = "assistantReceipt";

export type AssistantReceiptSkipReason =
  | "NOT_SUCCESS"
  | "NOT_JSON"
  | "NO_ASSISTANT_MESSAGE"
  | "KEY_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "MISSING_CHAT"
  | "CHAT_NOT_OWNED"
  | "ECHOES_CLIENT_INPUT"
  | "SIGN_FAILED";

export type AssistantReceiptDeps = {
  // userId de la sesión validada en el servidor, o null si no hay sesión válida.
  authenticate: (req: Request) => Promise<string | null>;
  isChatOwner: (userId: string, chatId: string) => Promise<boolean>;
  getKey: () => AssistantReceiptKeyStatus;
  now?: () => number;
  // Solo recibe el motivo: nunca el texto, el usuario ni el secreto.
  onSkip?: (reason: AssistantReceiptSkipReason) => void;
};

type JsonRecord = Record<string, unknown>;

const ChatIdSchema = z.string().uuid();
const MAX_CLIENT_STRINGS = 5000;
const MAX_CLIENT_DEPTH = 8;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStrings(value: unknown, out: Set<string>, depth: number): void {
  if (out.size >= MAX_CLIENT_STRINGS || depth > MAX_CLIENT_DEPTH) return;
  if (typeof value === "string") {
    out.add(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

async function readJson(source: Request | Response): Promise<unknown> {
  try {
    return await source.json();
  } catch {
    return null;
  }
}

export function withAssistantReceipt<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
  deps: AssistantReceiptDeps,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    if (typeof window !== "undefined") {
      throw new Error("withAssistantReceipt solo puede usarse en el servidor.");
    }

    const req = args[0];
    // Copia del cuerpo antes de que el handler lo consuma; el handler recibe la petición
    // original sin cambios.
    let probe: Request | null = null;
    try {
      probe = req.clone();
    } catch {
      probe = null;
    }

    const res = await handler(...args);

    const skip = (reason: AssistantReceiptSkipReason): Response => {
      deps.onSkip?.(reason);
      return res;
    };

    if (res.status < 200 || res.status >= 300) return skip("NOT_SUCCESS");
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return skip("NOT_JSON");

    const json = await readJson(res.clone());
    if (!isRecord(json)) return skip("NOT_JSON");
    if (json.ok !== true) return skip("NOT_SUCCESS");

    const target: JsonRecord | null =
      isRecord(json.data) && typeof json.data.assistantMessage === "string"
        ? json.data
        : typeof json.assistantMessage === "string"
          ? json
          : null;
    const message = target?.assistantMessage;
    if (!target || typeof message !== "string" || message.trim() === "") {
      return skip("NO_ASSISTANT_MESSAGE");
    }

    const keyStatus = deps.getKey();
    if (!keyStatus.ok) return skip("KEY_UNAVAILABLE");

    let userId: string | null = null;
    try {
      userId = await deps.authenticate(req);
    } catch {
      userId = null;
    }
    if (!userId) return skip("UNAUTHENTICATED");

    const body = probe ? await readJson(probe) : null;
    const chatId = isRecord(body) ? body.chatId : undefined;
    const parsedChatId = ChatIdSchema.safeParse(chatId);
    if (!parsedChatId.success) return skip("MISSING_CHAT");

    let owned = false;
    try {
      owned = await deps.isChatOwner(userId, parsedChatId.data);
    } catch {
      owned = false;
    }
    if (!owned) return skip("CHAT_NOT_OWNED");

    const clientStrings = new Set<string>();
    collectStrings(body, clientStrings, 0);
    if (clientStrings.has(message.trim())) return skip("ECHOES_CLIENT_INPUT");

    let receipt: string;
    try {
      receipt = signAssistantReceipt(
        keyStatus.key,
        { userId, chatId: parsedChatId.data, content: message },
        deps.now ? { now: deps.now() } : {},
      );
    } catch {
      return skip("SIGN_FAILED");
    }

    const signedTarget: JsonRecord = { ...target, [ASSISTANT_RECEIPT_FIELD]: receipt };
    const signedJson: JsonRecord = target === json ? signedTarget : { ...json, data: signedTarget };

    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(signedJson), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
