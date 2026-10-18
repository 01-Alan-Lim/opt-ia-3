// src/lib/chat/persistChatMessage.ts

// Guardado de un mensaje desde POST /api/messages: carga el chat, aplica la política
// (messageWritePolicy.ts) y lo inserta. Las dependencias llegan por parámetro para probarlo sin
// red; la ruta pasa las de producción (supabaseMessageStore, gate académico, clave de recibos).

import type { ApiErrorCode } from "@/lib/api/response";
import type { AssistantReceiptKeyStatus } from "@/lib/chat/assistantReceiptConfig";
import type { MessageStore, StoredMessage } from "@/lib/chat/messageStore";
import {
  decideMessageWrite,
  type MessageAccessGate,
  type MessageInsertRow,
  type PersistMessageBody,
} from "@/lib/chat/messageWritePolicy";

export type PersistChatMessageResult =
  | { ok: true; message: StoredMessage; duplicate: boolean }
  | { ok: false; status: number; code: ApiErrorCode; message: string };

export async function persistChatMessage(input: {
  userId: string;
  body: PersistMessageBody;
  gate: () => Promise<MessageAccessGate>;
  store: MessageStore;
  receiptKey: () => AssistantReceiptKeyStatus;
  now?: number;
}): Promise<PersistChatMessageResult> {
  const { userId, body, store } = input;

  const loaded = await store.loadChat(body.chatId);
  if (!loaded.ok) {
    return { ok: false, status: 500, code: "INTERNAL", message: "No se pudo validar el chat" };
  }

  const decision = decideMessageWrite({
    userId,
    body,
    chat: loaded.chat,
    gate: await input.gate(),
    receiptKey: input.receiptKey,
    now: input.now,
  });
  if (!decision.ok) {
    return { ok: false, status: decision.status, code: decision.code, message: decision.message };
  }

  const inserted = await store.insert(decision.row);
  if (inserted.ok) return { ok: true, message: inserted.message, duplicate: false };

  if (inserted.failure === "SCHEMA_NOT_READY") {
    return {
      ok: false,
      status: 503,
      code: "SCHEMA_NOT_READY",
      message: "El historial no está disponible: falta preparar la base de datos para esta versión.",
    };
  }
  if (inserted.failure === "DUPLICATE") {
    return resolveDuplicate(store, decision.row);
  }
  return { ok: false, status: 500, code: "INTERNAL", message: "No se pudo guardar el mensaje" };
}

// Idempotencia (R1-D). Los índices únicos de M2 deciden en Postgres, también entre solicitudes
// concurrentes o instancias distintas: solo una inserción gana. Las demás devuelven la fila que
// ya existe, sin crear otra:
//   - assistant: un recibo, una fila (receipt_nonce). El recibo ya se verificó para este
//     usuario y este chat, así que la fila existente es esa misma respuesta.
//   - user/advisor: un client_message_id por chat. Si llega con otro texto u otro role, no es
//     un reintento: 409.
async function resolveDuplicate(store: MessageStore, row: MessageInsertRow): Promise<PersistChatMessageResult> {
  const existing = row.receipt_nonce
    ? await store.findByReceiptNonce(row.receipt_nonce)
    : row.client_message_id
      ? await store.findByClientMessageId(row.chat_id, row.client_message_id)
      : null;

  if (!existing) {
    return { ok: false, status: 500, code: "INTERNAL", message: "No se pudo guardar el mensaje" };
  }

  const sameMessage =
    existing.chatId === row.chat_id &&
    existing.role === row.role &&
    (row.receipt_nonce !== undefined || existing.content === row.content);

  if (!sameMessage) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "La clave de este mensaje ya se usó para otro mensaje.",
    };
  }

  return { ok: true, message: existing, duplicate: true };
}
