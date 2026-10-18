// src/app/chat/_lib/appendAssistantMessage.ts
//
// Cuerpo de appendAssistant (src/app/chat/page.tsx): en modo plan_mejora suaviza el arranque y
// da formato al texto (formatAdvisorReplyForChat), lo pinta y lo guarda una vez con
// persistMessageDB. El texto que se ve es el de siempre.
//
// Procedencia (R1, ver messageProvenance.ts). Lo decide classifyAdvisorText:
//   - respuesta de una ruta assistant (reply, con el texto exacto que recibió): se guarda como
//     assistant con su recibo, en el chat de la petición, que es al que está atado el recibo y
//     donde el turno guarda el estado de la etapa. El servidor verifica el recibo y calcula el
//     texto guardado, que coincide con el que se pinta aquí.
//   - todo lo demás (los textos locales del asesor): se guarda como advisor en el chat activo,
//     con el id del mensaje como clave de idempotencia. Nunca como assistant.
// Las ~113 llamadas a appendAssistant no cambian: la decisión está aquí.

import type { Message } from "@/lib/types";
import { createMessage, formatAdvisorReplyForChat } from "@/lib/chat/assistantFormat";
import { classifyAdvisorText, type SignedAssistantReply } from "@/lib/chat/signedAssistantReply";
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

  const advisorMode = modeRef.current === "plan_mejora";
  const safe = advisorMode ? formatAdvisorReplyForChat(safeRaw) : safeRaw;

  // El recibo se compara con el texto que llegó, no con el ya formateado.
  const origin = classifyAdvisorText(content, reply);
  const message = createMessage(origin.origin === "server" ? "assistant" : "advisor", safe);

  setMessages((prev) => [...prev, message]);

  if (!advisorMode) return;

  if (origin.origin === "server") {
    await persistMessageDB({ chatId: origin.chatId, role: "assistant", serverReply: origin.serverReply });
    return;
  }

  if (chatIdRef.current) {
    await persistMessageDB({ chatId: chatIdRef.current, role: "advisor", content: safe, clientMessageId: message.id });
  }
}
