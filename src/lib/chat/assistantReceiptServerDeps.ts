// src/lib/chat/assistantReceiptServerDeps.ts

// Dependencias de producción de withAssistantReceipt. Separadas del adaptador para que este
// se pueda probar sin Supabase: este archivo sí carga supabaseServer (vía assertChatOwner) y
// requireUser, así que solo deben importarlo rutas de servidor.
//
// Todavía no lo usa ninguna ruta.

import { assertChatOwner } from "@/lib/auth/chatOwner";
import { requireUser } from "@/lib/auth/supabase";
import { getAssistantReceiptKey } from "@/lib/chat/assistantReceiptConfig";
import type { AssistantReceiptDeps } from "@/lib/chat/withAssistantReceipt";

let warnedKeyUnavailable = false;

export const assistantReceiptServerDeps: AssistantReceiptDeps = {
  authenticate: async (req) => {
    try {
      return (await requireUser(req)).userId;
    } catch {
      return null;
    }
  },
  isChatOwner: async (userId, chatId) => (await assertChatOwner(userId, chatId)).ok,
  getKey: getAssistantReceiptKey,
  onSkip: (reason) => {
    if (reason !== "KEY_UNAVAILABLE" || warnedKeyUnavailable) return;
    warnedKeyUnavailable = true;
    const status = getAssistantReceiptKey();
    const detail = status.ok ? "" : ` (${status.reason})`;
    console.warn(`[assistant-receipt] recibos desactivados: ASSISTANT_RECEIPT_SECRET no disponible${detail}.`);
  },
};
