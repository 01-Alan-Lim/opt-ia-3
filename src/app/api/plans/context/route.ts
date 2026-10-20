// src/app/api/plans/context/route.ts

import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { failResponse } from "@/lib/api/response";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { ensurePlanChat, resolvePlanChatId } from "@/lib/plan/planChat";
import { findInvalidStage0Fields, stage0FieldLabel } from "@/lib/plan/stage0Values";

export const runtime = "nodejs";

const ContextUpsertSchema = z.object({
  chatId: z.string().uuid().nullable().optional(),

  // Pide el chat del plan sin guardar contexto (con contextJson {} y contextText null). Ya no crea
  // un chat nuevo si el plan tiene uno, ni reinicia el contexto: E0 solo se reinicia a propósito.
  forceNew: z.boolean().optional(),

  contextJson: z.record(z.string(), z.any()).optional(),

  // ✅ IMPORTANTE: permitir null para evitar el error "expected string, received null"
  contextText: z.string().max(5000).nullable().optional(),
});

// Este endpoint guardaba también userMessage y assistantMessage del navegador en messages, con
// service role y role "assistant" sin verificar (R1-B). Ningún cliente los envía (ni main ni el
// release): los mensajes del chat se guardan solo por /api/messages, que exige recibo para
// assistant. Si llegan, se rechaza la petición entera en vez de ignorarlos en silencio.
const RETIRED_MESSAGE_FIELDS = ["userMessage", "assistantMessage"] as const;

function sendsRetiredMessageFields(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && RETIRED_MESSAGE_FIELDS.some((field) => field in raw));
}

async function getRow(userId: string) {
  return supabaseServer
    .from("plan_case_contexts")
    .select("id,user_id,chat_id,status,version,context_json,context_text,created_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
}

type ChatOwnershipResult =
  | { ok: true }
  | { ok: false; status: number; code: "NOT_FOUND" | "FORBIDDEN" | "INTERNAL"; message: string };

async function assertChatOwner(userId: string, chatId: string): Promise<ChatOwnershipResult> {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .maybeSingle();

  if (chatErr) {
    console.error("[plans] context: validacion de ownership de chat", chatErr);
    return { ok: false as const, status: 500, code: "INTERNAL", message: "No se pudo validar el chat." };
  }

  if (!chatRow) {
    return { ok: false as const, status: 404, code: "NOT_FOUND", message: "Chat no encontrado." };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false as const, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat." };
  }

  return { ok: true as const };
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    const { data, error } = await getRow(authed.userId);
    if (error) {
      console.error("[plans] context: lectura de contexto", error);
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el contexto del caso."), {
        status: 500,
      });
    }

    // Si no existe, devolvemos un default (sin crear nada todavía). chatId es el chat principal del
    // plan (planChat.ts): un chat del asesor de este estudiante, o null si el plan aún no tiene.
    const planChatId = await resolvePlanChatId(authed.userId, (data?.chat_id as string | null) ?? null);

    return ok({
      status: data?.status ?? "draft",
      version: data?.version ?? 1,
      chatId: planChatId,
      contextJson: data?.context_json ?? {},
      contextText: data?.context_text ?? null,
      exists: !!data,
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    console.error("[plans] context: error interno", err);
    return failResponse(
      "INTERNAL",
      "Error interno.",
      500
    );
  }
}

export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(fail("BAD_REQUEST", "Body JSON inválido."), { status: 400 });
    }

    if (sendsRetiredMessageFields(raw)) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Este endpoint no guarda mensajes del chat: usa /api/messages."),
        { status: 400 }
      );
    }

    const parsed = ContextUpsertSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Payload inválido."),
        { status: 400 }
      );
    }

    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    const chatId = parsed.data.chatId ?? null;
    const forceNew = parsed.data.forceNew ?? false;

    const incomingJson = parsed.data.contextJson ?? {};
    const contextText = parsed.data.contextText ?? null;

    // Los datos que llegan tienen que ser datos del caso (stage0Values.ts): nada de "Confidencial",
    // "No decirlo", frases de la conversación ni nombres de empresas, aunque el cliente los mande.
    // Solo se revisa lo que llega: un campo vacío es un dato pendiente.
    const invalid = findInvalidStage0Fields(incomingJson);
    if (invalid.length) {
      return failResponse(
        "INVALID_CONTEXT_VALUE",
        `No registré ${stage0FieldLabel(invalid[0].field)}: no parece un dato del caso. Escríbelo con palabras generales, sin nombres de empresas.`,
        400
      );
    }

    // 1) Leemos contexto actual (para merge)
    const { data: current, error: curErr } = await getRow(authed.userId);
    if (curErr) {
      console.error("[plans] context: lectura de contexto actual", curErr);
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el contexto actual."), {
        status: 500,
      });
    }

    // 2) Detectar "solo crear chat"
    const isChatOnly =
      forceNew &&
      Object.keys(incomingJson).length === 0 &&
      contextText === null;

    // 3) El chat que manda el cliente debe ser suyo (no decide cuál es el chat del plan).
    if (chatId) {
      const access = await assertChatOwner(authed.userId, chatId);
      if (!access.ok) {
        return failResponse(access.code, access.message, access.status);
      }
    }

    // El chat principal del plan (planChat.ts): el que ya tiene, o el primero si todavía no hay.
    // Nunca uno nuevo por pedirlo con forceNew ni por guardar desde otro chat del asesor.
    const planChat = await ensurePlanChat(authed.userId, (current?.chat_id as string | null) ?? null, chatId);
    if (!planChat.ok) {
      return NextResponse.json(fail("INTERNAL", planChat.message), { status: 500 });
    }
    const effectiveChatId = planChat.chatId;

    // 4) isChatOnly: solo el chat del plan, sin tocar el contexto ni escribir mensajes.
    if (isChatOnly) {
      const { data: row, error: rowErr } = await getRow(authed.userId);
      if (rowErr) {
        console.error("[plans] context: lectura tras preparar el chat", rowErr);
        return NextResponse.json(fail("INTERNAL", "No se pudo leer el contexto del caso."), { status: 500 });
      }

      return ok({
        exists: Boolean(row),
        status: row?.status ?? "draft",
        version: row?.version ?? 1,
        chatId: effectiveChatId,
        contextJson: row?.context_json ?? {},
        contextText: row?.context_text ?? null,
      });
    }

    // 5) Merge JSON sobre lo guardado (forceNew ya no limpia el contexto)
    const mergedJson =
      current?.context_json && typeof current.context_json === "object"
        ? { ...(current.context_json as any), ...incomingJson }
        : { ...incomingJson };

    // 6) Mejorar título por sector
    const sectorTitle =
      typeof (mergedJson as any)?.sector === "string" ? (mergedJson as any).sector.trim() : "";
    if (sectorTitle) {
      await supabaseServer
        .from("chats")
        .update({ title: `Asesor - ${sectorTitle}` })
        .eq("id", effectiveChatId);
    }

    // 7) Upsert plan_case_contexts
    const { data, error } = await supabaseServer
      .from("plan_case_contexts")
      .upsert(
        {
          user_id: authed.userId,
          chat_id: effectiveChatId,
          status: (current?.status ?? "draft") as "draft" | "confirmed",
          version: current?.version ?? 1,
          context_json: mergedJson,
          context_text: contextText ?? current?.context_text ?? null,
        },
        { onConflict: "user_id" }

      )
      .select("status,version,chat_id,context_json,context_text")
      .single();

    if (error || !data) {
      console.error("[plans] context: guardado de contexto", error);
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar el contexto del caso."), {
        status: 500,
      });
    }

    // 8) Este endpoint no escribe en messages: la conversación de E0 la guarda el navegador por
    // /api/messages (sus textos locales como advisor).

    return ok({
      status: data.status,
      version: data.version,
      chatId: data.chat_id,
      contextJson: data.context_json,
      contextText: data.context_text,
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    console.error("[plans] context: error interno", err);
    return failResponse(
      "INTERNAL",
      "Error interno.",
      500
    );
  }
}
