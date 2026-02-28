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

  // Input de archivo (Word/PDF)
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!onUploadFile) return;

    onUploadFile(file);
    e.target.value = ""; // permite volver a subir el mismo archivo
  }

  // Auto-ajustar altura hasta un máximo
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 160);
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
    <div className="w-full">
      <form onSubmit={handleSubmit} className="relative z-10 w-full">
        <div
          className={[
            "mx-auto max-w-4xl",
            "rounded-3xl",
            "border border-[color:var(--border)]",
            "bg-[color:var(--surface)] backdrop-blur-md supports-[backdrop-filter]:bg-[color:var(--surface)]/70",
            "shadow-[0_20px_60px_rgba(0,0,0,0.45)]",
            "px-4 py-3",
          ].join(" ")}
        >
          <div className="flex items-center gap-3">
            {/* Botón adjuntar (solo si hay handler, i.e. etapa final) */}
            {onUploadFile ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
                    "h-[44px] w-[44px] shrink-0",
                    "rounded-2xl",
                    "border border-slate-800/60",
                    "bg-slate-950/20",
                    "text-slate-200",
                    "hover:bg-slate-900/30",
                    "transition",
                    "disabled:opacity-60",
                    "grid place-items-center",
                  ].join(" ")}
                >
                  {/* clip */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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

            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder="Escribe tu mensaje aquí..."
              className={[
                "w-full resize-none",
                "overflow-hidden",
                "rounded-2xl",
                "bg-transparent",
                "px-4 py-3",
                "text-sm text-slate-100 placeholder:text-slate-500",
                "focus:outline-none",
                "min-h-[44px]",
              ].join(" ")}
              style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            />

            <button
              type="submit"
              disabled={disabled || !text.trim()}
              aria-label="Enviar"
              title="Enviar"
              className={[
                "h-[44px] w-[44px] shrink-0",
                "rounded-2xl",
                "bg-sky-700 hover:bg-sky-600",
                "text-white",
                "shadow-[0_12px_30px_rgba(2,132,199,0.20)]",
                "transition",
                "disabled:opacity-60",
                "grid place-items-center",
              ].join(" ")}
            >
              {/* icono enviar */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M22 2L11 13"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
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