"use client";

import { useState, useRef, useEffect } from "react";

export function MessageInput({
  onSend,
  disabled,
  onUploadFile,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
  onUploadFile?: (file: File) => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!onUploadFile) return;

    onUploadFile(file);
    e.target.value = "";
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 140);
    el.style.height = `${next}px`;
  }, [text]);

  function sendIfNotEmpty() {
    const msg = text.trim();
    if (!msg) return;
    onSend(msg);
    setText("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    sendIfNotEmpty();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendIfNotEmpty();
    }
  }

  return (
    <div className="w-full pb-1 sm:pb-0">
      <form onSubmit={handleSubmit} className="relative z-10 w-full">
        <div
          className={[
            "mx-auto w-full max-w-4xl",
            "rounded-[20px] sm:rounded-3xl",
            "border border-[color:var(--border)]",
            "bg-[color:var(--surface)] backdrop-blur-md supports-[backdrop-filter]:bg-[color:var(--surface)]/70",
            "shadow-[0_16px_40px_rgba(0,0,0,0.16)]",
            "px-2.5 py-2 sm:px-4 sm:py-3",
          ].join(" ")}
        >
          <div className="flex items-end gap-2 sm:items-center sm:gap-3">
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder="Escribe tu mensaje aquí..."
              className={[
                "w-full resize-none overflow-hidden",
                "rounded-xl sm:rounded-2xl bg-transparent",
                "px-2.5 sm:px-4",
                "py-[8px] sm:py-[11px]",
                "min-h-9 sm:min-h-[44px]",
                "text-[13px] sm:text-sm",
                "leading-[1.45]",
                "text-[color:var(--foreground)] placeholder:text-[color:var(--muted)] caret-[color:var(--foreground)]",
                "focus:outline-none",
              ].join(" ")}
              style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            />

            {onUploadFile ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={handleUploadClick}
                  disabled={disabled}
                  aria-label="Adjuntar archivo"
                  title="Adjuntar archivo"
                  className={[
                    "h-9 w-9 sm:h-11 sm:w-11 shrink-0",
                    "rounded-xl sm:rounded-2xl",
                    "border border-[color:var(--border)]",
                    "bg-[color:var(--surface)]",
                    "text-[color:var(--foreground)]",
                    "hover:bg-[color:var(--surface-elevated)]",
                    "transition",
                    "disabled:opacity-60",
                    "grid place-items-center",
                  ].join(" ")}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M21.44 11.05L12.25 20.24C10.01 22.48 6.38 22.48 4.14 20.24C1.9 18 1.9 14.37 4.14 12.13L13.33 2.94C14.82 1.45 17.24 1.45 18.73 2.94C20.22 4.43 20.22 6.85 18.73 8.34L9.54 17.53C8.79 18.28 7.58 18.28 6.83 17.53C6.08 16.78 6.08 15.57 6.83 14.82L15.31 6.34"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </>
            ) : null}

            <button
              type="submit"
              disabled={disabled || !text.trim()}
              aria-label="Enviar"
              title="Enviar"
              className={[
                "h-9 w-9 sm:h-11 sm:w-11 shrink-0",
                "rounded-xl sm:rounded-2xl",
                "bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]",
                "text-[color:var(--primary-foreground)]",
                "shadow-[0_10px_24px_rgba(2,132,199,0.18)]",
                "transition",
                "disabled:opacity-60",
                "grid place-items-center",
              ].join(" ")}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path
                  d="M22 2L15 22L11 13L2 9L22 2Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}