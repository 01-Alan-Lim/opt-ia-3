// src/app/chat/_lib/appendAssistantMessage.ts
//
// Cuerpo de appendAssistant (src/app/chat/page.tsx), movido tal cual para poder probarlo: en
// modo plan_mejora suaviza el arranque y da formato al texto, lo pinta y, si hay chat activo,
// lo guarda una vez con persistMessageDB. El texto pintado y el guardado son los de siempre.
//
// Lo nuevo es el recibo (R1). Si el mensaje es la respuesta de una ruta assistant que trajo
// recibo (reply, ver signedAssistantReply.ts), el guardado lleva además esa respuesta original
// con su recibo, sin tocarlos, para que el servidor pueda verificarla. Solo se adjunta si el
// texto recibido es exactamente el de la respuesta y se guarda en el chat de la petición; los
// mensajes locales y los que no cumplan se guardan igual que antes, sin recibo.

import type { Message } from "@/lib/types";
import {
  createMessage,
  formatAssistantMessageForReadability,
  softenAssistantLeadInChat,
} from "@/lib/chat/assistantFormat";
import { attachSignedReply, type SignedAssistantReply } from "@/lib/chat/signedAssistantReply";
import type { PersistMessageInput } from "./advisorApi";

export type AppendAssistantDeps = {
  modeRef: { current: "general" | "plan_mejora" };
  chatIdRef: { current: string | null };
  setMessages: (update: (prev: Message[]) => Message[]) => void;
  persistMessageDB: (input: PersistMessageInput) => Promise<unknown>;
};

export async function appendAssistantMessage(
  deps: AppendAssistantDeps,
  content: unknown,
  reply?: SignedAssistantReply | null,
) {
  const { modeRef, chatIdRef, setMessages, persistMessageDB } = deps;

  const safeRaw =
    typeof content === "string"
      ? content
      : content == null
        ? ""
        : (() => {
            try {
              return JSON.stringify(content);
            } catch {
              return String(content);
            }
          })();

  let safe =
    modeRef.current === "plan_mejora"
      ? softenAssistantLeadInChat(safeRaw)
      : safeRaw;

  if (modeRef.current === "plan_mejora") {
    safe = formatAssistantMessageForReadability(safe);
  }

  setMessages((prev) => [...prev, createMessage("assistant", safe)]);

  if (modeRef.current === "plan_mejora" && chatIdRef.current) {
    // El recibo se compara con el texto que llegó, no con el ya formateado. Un contenido que no
    // es texto nunca es el assistantMessage de una ruta.
    const signed =
      typeof content === "string"
        ? attachSignedReply({ content, chatId: chatIdRef.current, reply })
        : null;

    await persistMessageDB({
      chatId: chatIdRef.current,
      role: "assistant",
      content: safe,
      ...(signed?.attached ? { serverReply: signed.serverReply } : {}),
    });
  }
}
