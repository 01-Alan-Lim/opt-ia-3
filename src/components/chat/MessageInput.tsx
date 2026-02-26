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
    <div className="w-full">
      <form onSubmit={handleSubmit} className="relative z-10 w-full flex justify-center">
        <div className="flex items-center gap-2 w-full max-w-2xl px-2 py-2">
          <div
            className="
              flex-1
              rounded-2xl border border-[color:var(--border)]
              bg-[color:var(--surface)] backdrop-blur-xl
              chat-bubble-shadow
            "
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder="Escribe tu mensaje …"
              className="
                w-full resize-none
                rounded-2xl
                px-4
                py-[13px]
                text-sm
                leading-[22px]
                min-h-12
                h-12
                outline-none
                bg-transparent
                border-0
                text-[color:var(--foreground)]
                placeholder:text-[color:var(--muted)]
                focus:outline-none focus:ring-0
                disabled:opacity-60
              "
              style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            />
          </div>
          <button
            type="submit"
            disabled={disabled}
            aria-label="Enviar"
            title="Enviar"
            className="
              h-12 w-12
              rounded-2xl
              bg-sky-600 hover:bg-sky-500 disabled:opacity-50
              text-white
              flex items-center justify-center
              transition
            "
          >
            {/* Ícono enviar minimalista */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );

}
