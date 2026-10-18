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
    return { ok: false, status: 409, code: "CONFLICT", message: "Este mensaje ya estaba guardado." };
  }
  return { ok: false, status: 500, code: "INTERNAL", message: "No se pudo guardar el mensaje" };
}
