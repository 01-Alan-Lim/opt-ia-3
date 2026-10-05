// src/app/chat/_lib/useChatHistory.ts
//
// Historial del chat: al entrar o cambiar de modo lo hidrata desde sessionStorage (2a), si hay
// chatId lo trae de /api/messages (2b) y guarda en sessionStorage el chat y los mensajes (2c).
// chatId, messages y los refs siguen en page.tsx (los escriben handleSend, las transiciones y
// handleNewChat): aquí llegan por parámetro. Los effects se movieron tal cual y page.tsx los
// llama en sus posiciones de siempre.

import { useEffect } from "react";
import type { useRouter } from "next/navigation";
import { createMessage } from "@/lib/chat/assistantFormat";
import { supabase } from "@/lib/supabaseClient";
import type { Message } from "@/lib/types";

// Saludo del modo general cuando el historial está vacío (también lo usa handleNewChat).
export const GREETING =
  "Hola, soy OPT-IA. Me conecto a Supabase y Google AI para ayudarte con productividad en MyPEs.";

type ChatRouter = ReturnType<typeof useRouter>;

export function useChatHistory({
  ready,
  authenticated,
  mode,
  modeRef,
  chatId,
  setChatId,
  setMessages,
  storageKeyChat,
  storageKeyMsgs,
  getAuthHeaders,
  router,
}: {
  ready: boolean;
  authenticated: boolean;
  mode: "general" | "plan_mejora";
  modeRef: { current: "general" | "plan_mejora" };
  chatId: string | null;
  setChatId: (value: string | null) => void;
  setMessages: (value: Message[]) => void;
  storageKeyChat: string;
  storageKeyMsgs: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  router: ChatRouter;
}) {
  // -----------------------------
  // 2a. Cargar desde sessionStorage
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;

    try {
      const storedChatId = window.sessionStorage.getItem(storageKeyChat);
      const storedMsgs = window.sessionStorage.getItem(storageKeyMsgs);

      setChatId(storedChatId || null);

      if (storedMsgs) {
        const parsed = JSON.parse(storedMsgs);

        // ✅ Si estaba guardado "[]", lo tratamos como vacío real (mostrar saludo)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        } else {
          if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
          else setMessages([]);
        }
      } else {
        if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
        else setMessages([]);
      }
    } catch (e) {
      console.warn("No se pudo leer storage:", e);
      if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
      else setMessages([]); // ✅ Asesor en blanco
    }



  }, [ready, authenticated, storageKeyChat, storageKeyMsgs, mode]);

  // -----------------------------
  // 2b. Cargar historial del backend (si hay chatId)
  // -----------------------------
  useEffect(() => {
    if (!ready) return;

    if (!authenticated) {
      setChatId(null);
      setMessages(modeRef.current === "general"
        ? [createMessage("assistant", GREETING)]
        : []
      );
      return;
    }

    if (!chatId) return;

    async function loadMessages() {
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`/api/messages?chatId=${chatId}`, {
          headers: { ...authHeaders },
        });

        if (res.status === 401) {
          await supabase.auth.signOut();
          router.replace("/");
          return;
        }

        const data = await res.json();

        if (res.ok && data?.ok !== false) {
          const msgs = data?.data?.messages ?? data?.messages;
          if (Array.isArray(msgs) && msgs.length > 0) {
            setMessages(
              (Array.isArray(msgs) ? msgs : []).map((m: any) => ({
                ...m,
                content: typeof m?.content === "string" ? m.content : String(m?.content ?? ""),
              }))
            );
          }
        }

      } catch (err) {
        console.error("Error al cargar mensajes:", err);
      }
    }

    loadMessages();
  }, [ready, authenticated, chatId]);
}

export function useChatHistoryPersistence({
  authenticated,
  chatId,
  messages,
  storageKeyChat,
  storageKeyMsgs,
}: {
  authenticated: boolean;
  chatId: string | null;
  messages: Message[];
  storageKeyChat: string;
  storageKeyMsgs: string;
}) {
  // -----------------------------
  // 2c. Guardar en sessionStorage
  // -----------------------------
  useEffect(() => {
    if (!authenticated) return;

    try {
      if (chatId) window.sessionStorage.setItem(storageKeyChat, chatId);
      else window.sessionStorage.removeItem(storageKeyChat);
        if (messages.length) window.sessionStorage.setItem(storageKeyMsgs, JSON.stringify(messages));
        else window.sessionStorage.removeItem(storageKeyMsgs);
      } catch (e) {
        console.warn("No se pudo guardar en storage:", e);
      }
    }, [authenticated, chatId, messages, storageKeyChat, storageKeyMsgs]);
}
