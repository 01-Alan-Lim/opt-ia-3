// src/lib/chat/messageStore.ts

// Acceso a public.messages y public.chats para POST /api/messages, con supabaseServer (service
// role). Solo para rutas de servidor. Traduce los errores de Postgres/PostgREST a lo que la
// ruta necesita distinguir:
//   - DUPLICATE: choca con un índice único de M2 (receipt_nonce o chat_id+client_message_id).
//   - SCHEMA_NOT_READY: la base todavía no tiene M2 (columna desconocida o CHECK de role
//     antiguo, que no admite advisor). No se guarda nada: el código nuevo no escribe a medias.

import { supabaseServer } from "@/lib/supabaseServer";
import type { MessageChat, MessageInsertRow } from "@/lib/chat/messageWritePolicy";
import type { Message } from "@/lib/types";

export const MESSAGE_SELECT = "id, chat_id, role, content, created_at";

export type StoredMessage = Message & { chatId: string };

export type MessageInsertFailure = "DUPLICATE" | "SCHEMA_NOT_READY" | "ERROR";

export type MessageStore = {
  loadChat(chatId: string): Promise<{ ok: true; chat: MessageChat | null } | { ok: false }>;
  insert(row: MessageInsertRow): Promise<{ ok: true; message: StoredMessage } | { ok: false; failure: MessageInsertFailure }>;
  findByReceiptNonce(nonce: string): Promise<StoredMessage | null>;
  findByClientMessageId(chatId: string, clientMessageId: string): Promise<StoredMessage | null>;
};

type DbError = { code?: string | null; message?: string | null } | null | undefined;

export function classifyMessageInsertError(error: DbError): MessageInsertFailure {
  const code = error?.code ?? "";
  if (code === "23505") return "DUPLICATE";
  if (code === "PGRST204" || code === "42703") return "SCHEMA_NOT_READY";
  if (code === "23514" && (error?.message ?? "").includes("messages_role_check")) return "SCHEMA_NOT_READY";
  return "ERROR";
}

type MessageRow = { id: string; chat_id: string; role: string; content: string; created_at: string };

function toStored(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as Message["role"],
    content: row.content,
    createdAt: row.created_at,
  };
}

export const supabaseMessageStore: MessageStore = {
  async loadChat(chatId) {
    const { data, error } = await supabaseServer
      .from("chats")
      .select("id, client_id, mode")
      .eq("id", chatId)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, chat: null };
    return { ok: true, chat: { ownerId: String(data.client_id), mode: (data.mode as string | null) ?? null } };
  },

  async insert(row) {
    const { data, error } = await supabaseServer.from("messages").insert(row).select(MESSAGE_SELECT).single();
    if (error || !data) {
      const failure = classifyMessageInsertError(error);
      if (failure !== "DUPLICATE") console.error("[messages] no se pudo guardar el mensaje", { code: error?.code ?? null, failure });
      return { ok: false, failure };
    }
    return { ok: true, message: toStored(data as MessageRow) };
  },

  async findByReceiptNonce(nonce) {
    const { data, error } = await supabaseServer
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("receipt_nonce", nonce)
      .maybeSingle();
    return error || !data ? null : toStored(data as MessageRow);
  },

  async findByClientMessageId(chatId, clientMessageId) {
    const { data, error } = await supabaseServer
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("chat_id", chatId)
      .eq("client_message_id", clientMessageId)
      .maybeSingle();
    return error || !data ? null : toStored(data as MessageRow);
  },
};
