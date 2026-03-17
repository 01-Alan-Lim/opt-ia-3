"use client";

import { useEffect, useRef } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message } from "@/lib/types";
import clsx from "clsx";

function TypingDots() {
  return (
    <span className="typing-dots" aria-label="Escribiendo">
      <span />
      <span />
      <span />
    </span>
  );
}

const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2 text-sky-300 hover:text-sky-200 break-all"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mb-3 text-base sm:text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-[15px] sm:text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-sky-400/50 pl-3 italic text-[color:var(--muted)]">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-black/25 px-1.5 py-0.5 text-[12px]">{children}</code>
  ),
};

function renderMessageContent(content: unknown) {
  const text =
    typeof content === "string"
      ? content
      : content == null
        ? ""
        : (() => {
            try {
              return JSON.stringify(content, null, 2);
            } catch {
              return String(content);
            }
          })();

  return (
    <div className="break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
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

    if (prevLen === 0) return;

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
          maskImage:
            "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
        }}
      >
        <div className="min-h-full flex flex-col justify-start">
          <div className="space-y-3 sm:space-y-5">
            {messages.map((msg) => {
              const isUser = msg.role === "user";

              return (
                <div
                  key={msg.id}
                  className={clsx("flex w-full", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={clsx(
                      "max-w-[84%] sm:max-w-[78%] md:max-w-[72%]",
                      "px-3 py-2.5 sm:px-4 sm:py-3",
                      "text-[13px] sm:text-sm leading-[1.55] sm:leading-relaxed",
                      "border shadow-[0_10px_30px_rgba(0,0,0,0.25)]",
                      isUser
                        ? "rounded-2xl sm:rounded-3xl rounded-br-lg sm:rounded-br-xl bg-[color:var(--bubble-user-bg)] border-[color:var(--bubble-user-border)] text-[color:var(--bubble-user-text)]"
                        : "rounded-2xl sm:rounded-3xl rounded-bl-lg sm:rounded-bl-xl bg-[color:var(--bubble-assistant-bg)] border-[color:var(--bubble-assistant-border)] text-[color:var(--bubble-assistant-text)]"
                    )}
                  >
                    {renderMessageContent(msg.content)}
                  </div>
                </div>
              );
            })}

            {isTyping ? (
              <div className="flex w-full justify-start">
                <div
                  className={clsx(
                    "rounded-xl sm:rounded-2xl backdrop-blur-xl",
                    "bubble-assistant bg-[color:var(--surface-elevated)] text-[color:var(--foreground)] border border-[color:var(--border)]",
                    "shadow-[0_6px_14px_rgba(0,0,0,0.10)]",
                    "px-2.5 py-2 sm:px-3 inline-flex items-center"
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