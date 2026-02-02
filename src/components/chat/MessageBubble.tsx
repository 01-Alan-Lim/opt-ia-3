// src/components/chat/MessageBubble.tsx

import { Message } from "@/lib/types";
import clsx from "clsx";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  return (
    <div
      className={clsx("flex mb-3", {
        "justify-end": isUser,
        "justify-start": !isUser,
      })}
    >
      <div
        className={clsx(
          "max-w-[80%] rounded-2xl px-3 py-2 text-base leading-relaxed shadow-sm",
          {
            "bg-sky-500 text-white rounded-br-sm": isUser,
            "bg-[color:var(--surface)] text-[color:var(--foreground)] border border-[color:var(--border)] rounded-bl-sm":
              isAssistant,
            "bg-[color:var(--surface)] text-[color:var(--foreground)] border border-[color:var(--border)]":
              message.role === "system",
          }
        )}
      >
        <div className="whitespace-pre-wrap break-words">
          {/* versión simple: el navegador puede autolinkear si usas <a>, así que reaprovechamos la misma lógica */}
          {message.content}
        </div>

        <div className="mt-1 text-[11px] text-[color:var(--muted)] text-right">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

