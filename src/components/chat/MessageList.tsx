"use client";

import { useEffect, useRef } from "react";
import { Message } from "@/lib/types";
import clsx from "clsx";

export function MessageList({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <>
      {/* Contenedor con scrollbar oculto */}
      <div
        className="flex-1 overflow-y-auto space-y-5 pr-1 pl-1 sm:pl-2 scrollbar-none"
        style={{
          scrollbarWidth: "none", // Firefox
          msOverflowStyle: "none", // IE / Edge
        }}
      >
        {messages.map((msg) => {
          const isUser = msg.role === "user";

          return (
            <div
              key={msg.id}
              className={clsx(
                "flex w-full",
                isUser ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={clsx(
                  "max-w-[80%] rounded-2xl text-sm leading-relaxed shadow-xl backdrop-blur-xl",
                  "px-5 py-3",
                  isUser
                    ? "bg-sky-500/60 text-white shadow-sky-900/25"
                    : "bg-white/10 text-slate-100 border border-white/12"
                )}
                style={{ whiteSpace: "pre-line" }}
              >
                {msg.content.replace(/\*\*/g, "").replace(/###/g, "")}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* CSS nativo para ocultar scrollbar (Chrome / Safari) */}
      <style jsx>{`
        div::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </>
  );
}
