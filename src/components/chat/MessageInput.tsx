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

    // 👇 Input de archivo (Word/PDF)
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleUploadClick() {
    // Abre el selector de archivos
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!onUploadFile) return; // si no hay handler, no hacemos nada

    onUploadFile(file);

    // Permite volver a subir el mismo archivo después
    e.target.value = "";
  }


  // Auto-ajustar altura hasta ~5 líneas
  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto"; // reset
    const lineHeight = 22; // px aprox por línea
    const maxHeight = lineHeight * 5;
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;
  };

  useEffect(() => {
    autoResize();
  }, [text]);

  function sendIfNotEmpty() {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendIfNotEmpty();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter solo → enviar
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendIfNotEmpty();
    }
    // Shift+Enter → permite salto de línea (no hacemos nada especial)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full flex justify-center pt-2 pb-1"
    >
            <div className="flex items-center gap-2 w-full max-w-2xl px-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Escribe tu mensaje …"
          className="flex-1 resize-none rounded-2xl px-4 py-3 text-sm leading-5 outline-none
          bg-[color:var(--surface)] border border-[color:var(--border)]
          text-[color:var(--foreground)] placeholder-[color:var(--muted)]
          focus:ring-2 focus:ring-sky-400/30 disabled:opacity-60"
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
        />

        {/* 👇 Botón para subir Word/PDF (solo si viene onUploadFile) */}
        {onUploadFile && (
          <>
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={disabled}
              className="p-2 rounded-xl text-sm transition-all shadow-lg disabled:opacity-60
              bg-[color:var(--surface)] hover:bg-[color:var(--surface)]
              border border-[color:var(--border)]
              text-[color:var(--foreground)]"
              title="Subir Word/PDF del plan"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21 12.5 12.9 20.6a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 1 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {/* Input de archivo oculto */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx"
              className="hidden"
              onChange={handleFileChange}
            />
          </>
        )}

        <button
          type="submit"
          disabled={disabled}
          className="px-4 py-2.5 rounded-xl text-sm font-medium transition-all shadow-lg disabled:opacity-60
          bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]
          text-[color:var(--primary-foreground)]
          [html[data-theme='light']_&]:bg-[color:var(--primary-soft)]
          [html[data-theme='light']_&]:text-[color:var(--primary)]
          [html[data-theme='light']_&]:border
          [html[data-theme='light']_&]:border-[color:var(--border)]
          [html[data-theme='light']_&]:shadow-none"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}
