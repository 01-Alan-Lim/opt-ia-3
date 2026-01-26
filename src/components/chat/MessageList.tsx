"use client";

import { useEffect, useRef } from "react";
import { Message } from "@/lib/types";
import clsx from "clsx";

// Detecta URLs http/https en texto
const URL_RE = /\bhttps?:\/\/[^\s<>()]+/gi;

function stripMdLite(input: unknown): string {
  const s =
    typeof input === "string"
      ? input
      : input == null
        ? ""
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return String(input);
            }
          })();

  // tu limpieza actual: quita ** y ### (mantengo igual)
  return s.replace(/\*\*/g, "").replace(/###/g, "");
}


function renderTextWithLinks(text: unknown) {
  const clean = stripMdLite(text);

  // Split por líneas para conservar \n como <br/>
  const lines = clean.split("\n");

  return lines.map((line, lineIdx) => {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    // Reset regex state por seguridad
    URL_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(line)) !== null) {
      const url = match[0];
      const start = match.index;
      const end = start + url.length;

      // Texto antes del link
      if (start > lastIndex) {
        parts.push(line.slice(lastIndex, start));
      }

      // Link clickeable
      parts.push(
        <a
          key={`${lineIdx}-${start}-${url}`}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 text-sky-300 hover:text-sky-200 break-all"
        >
          {url}
        </a>
      );

      lastIndex = end;
    }

    // Texto restante
    if (lastIndex < line.length) {
      parts.push(line.slice(lastIndex));
    }

    return (
      <span key={`line-${lineIdx}`}>
        {parts}
        {lineIdx < lines.length - 1 ? <br /> : null}
      </span>
    );
  });
}

export function MessageList({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <>
      {/* Contenedor con scrollbar oculto */}
      <div
        className="message-scroll scrollbar-optia flex-1 min-h-0 overflow-y-auto space-y-5 pr-2 pl-1 sm:pl-2"
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
              className={clsx("flex w-full", isUser ? "justify-end" : "justify-start")}
            >
              <div
                className={clsx(
                  "max-w-[80%] rounded-2xl text-sm leading-relaxed shadow-xl backdrop-blur-xl",
                  "px-5 py-3",
                  isUser
                    ? "bg-sky-500/60 text-white shadow-sky-900/25"
                    : "bg-white/10 text-slate-100 border border-white/12"
                )}
              >
                {renderTextWithLinks(msg.content)}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>
    </>
  );
}
