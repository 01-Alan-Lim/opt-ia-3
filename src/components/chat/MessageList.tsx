"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
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

  // limpieza simple: quita ** y ### (mantengo igual)
  return s.replace(/\*\*/g, "").replace(/###/g, "");
}

function renderTextWithLinks(text: unknown) {
  const clean = stripMdLite(text);
  const lines = clean.split("\n");

  return lines.map((line, lineIdx) => {
    const parts: ReactNode[] = [];
    let lastIndex = 0;

    URL_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(line)) !== null) {
      const url = match[0];
      const start = match.index;
      const end = start + url.length;

      if (start > lastIndex) parts.push(line.slice(lastIndex, start));

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

    if (lastIndex < line.length) parts.push(line.slice(lastIndex));

    return (
      <span key={`line-${lineIdx}`}>
        {parts}
        {lineIdx < lines.length - 1 ? <br /> : null}
      </span>
    );
  });
}

function TypingDots() {
  return (
    <span className="typing-dots" aria-label="Escribiendo">
      <span />
      <span />
      <span />
    </span>
  );
}

export function MessageList({
  messages,
  isTyping = false,
}: {
  messages: Message[];
  isTyping?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const prevLenRef = useRef(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const prevLen = prevLenRef.current;
    const nextLen = messages.length;
    prevLenRef.current = nextLen;

    // primera carga: NO forzar scroll al fondo
    if (prevLen === 0) return;

    // si el usuario está cerca del fondo, auto-scroll
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 120;

    if (nearBottom || isTyping) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isTyping]);


  return (
  <div className="flex-1 min-h-0 relative h-full">
    <div
      ref={scrollerRef}
      className="absolute inset-0 overflow-y-auto scrollbar-optia px-3"
      style={{
        scrollPaddingBottom: "calc(var(--composer-h, 84px) + 24px)",
        // ✅ Desvanecimiento arriba/abajo (como el chat docente)
        maskImage:
          "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
      }}
    >
        {/* ✅ Hace que cuando hay pocos mensajes se queden abajo */}
        <div className="min-h-full flex flex-col justify-start">
          <div className="space-y-5">
            {messages.map((msg) => {
              const isUser = msg.role === "user";

              return (
                <div
                  key={msg.id}
                  className={clsx("flex w-full", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={clsx(
                      "max-w-[85%]",
                      "px-4 py-3",
                      "text-sm leading-relaxed",
                      "border",
                      "shadow-[0_10px_30px_rgba(0,0,0,0.25)]",
                      isUser
                        ? "rounded-3xl rounded-br-xl bg-[color:var(--bubble-user-bg)] border-[color:var(--bubble-user-border)] text-[color:var(--bubble-user-text)]"
                        : "rounded-3xl rounded-bl-xl bg-[color:var(--bubble-assistant-bg)] border-[color:var(--bubble-assistant-border)] text-[color:var(--bubble-assistant-text)] whitespace-pre-line"
                    )}
                  >
                    {renderTextWithLinks(msg.content)}
                  </div>
                </div>
              );
            })}
            {isTyping ? (
              <div className="flex w-full justify-start">
                <div
                  className={clsx(
                    "rounded-2xl backdrop-blur-xl",
                    "bubble-assistant bg-[color:var(--surface-elevated)] text-[color:var(--foreground)] border border-[color:var(--border)]",
                    "shadow-[0_6px_14px_rgba(0,0,0,0.10)]",
                    "px-3 py-2 inline-flex items-center"
                  )}
                >
                  <TypingDots />
                </div>
              </div>
            ) : null}
            <div
              aria-hidden="true"
              style={{ height: "calc(var(--composer-h, 84px) + 12px)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
