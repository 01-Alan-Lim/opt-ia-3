// src/lib/chat/messageWritePolicy.ts

// Política de escritura de POST /api/messages. Lógica pura, sin I/O: la ruta carga el chat y
// el gate académico, y esta función decide si se guarda y qué fila exactamente.
//
// Procedencia (ver messageProvenance.ts). El role que manda el navegador nunca prueba origen:
//   - user: texto del estudiante. Se guarda tal cual.
//   - advisor: texto local del asesor, generado en el navegador. Se guarda tal cual, solo en
//     chats del asesor (plan_mejora), y nunca cuenta como respuesta de la IA.
//   - assistant: solo con el recibo de la ruta assistant que emitió la respuesta. Se verifica
//     firma, versión, vigencia, usuario de la sesión, chat y texto original exacto. El content
//     que se guarda lo calcula el servidor a partir de ese original (el mismo formato que pinta
//     el navegador); el content que mande el cliente no se usa. Si el recibo falta o no
//     verifica, no se guarda nada: no se rebaja a advisor.
//   - system o cualquier otro valor: rechazado.
//
// Orden de comprobación: chat (404), dueño (403), gate académico (403), tipo de chat, recibo.
// El dueño va antes que el gate, así un chat ajeno responde igual tenga o no acceso el usuario.

import { z } from "zod";

import type { GateReason } from "@/lib/auth/chatAccess";
import { formatAdvisorReplyForChat } from "@/lib/chat/assistantFormat";
import { verifyAssistantReceipt, type AssistantReceiptRejection } from "@/lib/chat/assistantReceipt";
import type { AssistantReceiptKeyStatus } from "@/lib/chat/assistantReceiptConfig";
import { MESSAGE_ROLES } from "@/lib/chat/messageProvenance";

export const CLIENT_MESSAGE_ROLES = MESSAGE_ROLES;

// Texto del estudiante (como hasta ahora).
export const MESSAGE_CONTENT_MAX = 6000;
// Textos del asesor: los locales y las respuestas de las rutas pueden ser más largos.
export const ADVISOR_CONTENT_MAX = 20000;
const RECEIPT_MAX = 2048;

const ChatIdSchema = z.string().uuid();
const ClientMessageIdSchema = z.string().uuid().optional();

const UserBodySchema = z.object({
  chatId: ChatIdSchema,
  role: z.literal("user"),
  content: z.string().min(1).max(MESSAGE_CONTENT_MAX),
  clientMessageId: ClientMessageIdSchema,
});

const AdvisorBodySchema = z.object({
  chatId: ChatIdSchema,
  role: z.literal("advisor"),
  content: z.string().min(1).max(ADVISOR_CONTENT_MAX),
  clientMessageId: ClientMessageIdSchema,
});

const AssistantBodySchema = z.object({
  chatId: ChatIdSchema,
  role: z.literal("assistant"),
  // Se admite por compatibilidad, pero no se usa: el servidor formatea el original verificado.
  content: z.string().max(ADVISOR_CONTENT_MAX).optional(),
  // Opcional en el esquema para responder con un código propio si falta.
  serverReply: z
    .object({
      assistantMessage: z.string().min(1).max(ADVISOR_CONTENT_MAX),
      assistantReceipt: z.string().min(1).max(RECEIPT_MAX),
    })
    .optional(),
});

export const PersistMessageBodySchema = z.discriminatedUnion("role", [
  UserBodySchema,
  AdvisorBodySchema,
  AssistantBodySchema,
]);

export type PersistMessageBody = z.infer<typeof PersistMessageBodySchema>;

export function parsePersistMessageBody(
  raw: unknown,
): { ok: true; body: PersistMessageBody } | { ok: false; message: string } {
  const role = raw && typeof raw === "object" ? (raw as Record<string, unknown>).role : undefined;
  if (typeof role !== "string" || !(CLIENT_MESSAGE_ROLES as readonly string[]).includes(role)) {
    return { ok: false, message: "role no permitido: solo user, advisor o assistant con recibo." };
  }
  const parsed = PersistMessageBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Payload inválido" };
  }
  return { ok: true, body: parsed.data };
}

export type MessageAccessGate =
  | { ok: true }
  | { ok: false; reason: GateReason; message: string };

export type MessageChat = { ownerId: string; mode: string | null };

export type MessageInsertRow = {
  chat_id: string;
  role: "user" | "assistant" | "advisor";
  content: string;
  receipt_nonce?: string;
  client_message_id?: string;
};

export type MessageWriteErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | GateReason
  | "ASSISTANT_RECEIPT_REQUIRED"
  | "ASSISTANT_RECEIPT_INVALID"
  | "RECEIPT_KEY_UNAVAILABLE"
  | "BAD_REQUEST";

export type MessageWriteDecision =
  | { ok: true; row: MessageInsertRow }
  | {
      ok: false;
      status: 400 | 403 | 404 | 503;
      code: MessageWriteErrorCode;
      message: string;
      receiptRejection?: AssistantReceiptRejection;
    };

export function decideMessageWrite(input: {
  userId: string;
  body: PersistMessageBody;
  // null cuando el chat no existe.
  chat: MessageChat | null;
  gate: MessageAccessGate;
  // Solo se consulta para assistant.
  receiptKey: () => AssistantReceiptKeyStatus;
  now?: number;
}): MessageWriteDecision {
  const { userId, body, chat, gate } = input;

  if (chat === null) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Chat no encontrado" };
  }

  if (chat.ownerId !== userId) {
    return { ok: false, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat" };
  }

  if (!gate.ok) {
    return { ok: false, status: 403, code: gate.reason, message: gate.message };
  }

  if (body.role === "user") {
    return { ok: true, row: withClientId({ chat_id: body.chatId, role: "user", content: body.content }, body.clientMessageId) };
  }

  // advisor y assistant solo existen en el chat del asesor.
  if (chat.mode !== "plan_mejora") {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Solo el chat del asesor admite mensajes del asesor.",
    };
  }

  if (body.role === "advisor") {
    return {
      ok: true,
      row: withClientId({ chat_id: body.chatId, role: "advisor", content: body.content }, body.clientMessageId),
    };
  }

  if (!body.serverReply) {
    return {
      ok: false,
      status: 403,
      code: "ASSISTANT_RECEIPT_REQUIRED",
      message: "Una respuesta del asistente solo se guarda con el recibo del servidor que la emitió.",
    };
  }

  const key = input.receiptKey();
  if (!key.ok) {
    return {
      ok: false,
      status: 503,
      code: "RECEIPT_KEY_UNAVAILABLE",
      message: "No se puede verificar la respuesta del asesor: la verificación de recibos no está configurada en el servidor.",
    };
  }

  const original = body.serverReply.assistantMessage;
  const verification = verifyAssistantReceipt(
    key.key,
    body.serverReply.assistantReceipt,
    { userId, chatId: body.chatId, content: original },
    input.now === undefined ? {} : { now: input.now },
  );
  if (!verification.ok) {
    return {
      ok: false,
      status: 403,
      code: "ASSISTANT_RECEIPT_INVALID",
      message: `No se pudo verificar la respuesta del asesor (${verification.reason}).`,
      receiptRejection: verification.reason,
    };
  }

  const content = formatAdvisorReplyForChat(original);
  if (!content) {
    return { ok: false, status: 400, code: "BAD_REQUEST", message: "La respuesta del asesor está vacía." };
  }

  return {
    ok: true,
    row: { chat_id: body.chatId, role: "assistant", content, receipt_nonce: verification.receiptId },
  };
}

function withClientId(row: MessageInsertRow, clientMessageId: string | undefined): MessageInsertRow {
  return clientMessageId ? { ...row, client_message_id: clientMessageId } : row;
}
