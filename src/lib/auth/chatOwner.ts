// src/lib/auth/chatOwner.ts
import { supabaseServer } from "@/lib/supabaseServer";

export type ChatOwnerResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; code: "FORBIDDEN" | "NOT_FOUND"; message: string };

// Propiedad de un chat resuelta en el servidor: el chat debe existir y pertenecer al usuario
// autenticado (chats.client_id). El userId sale de la sesión (requireUser), nunca del cuerpo.
export async function assertChatOwner(userId: string, chatId: string): Promise<ChatOwnerResult> {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (chatErr || !chatRow) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Chat no encontrado." };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat." };
  }

  return { ok: true };
}
