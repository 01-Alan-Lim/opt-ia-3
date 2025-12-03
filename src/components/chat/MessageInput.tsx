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
            <div className="flex items-end gap-2 w-full max-w-2xl">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Escribe tu mensaje para OPT-IA…"
          className="
            flex-1 px-4 py-2 rounded-xl
            bg-white/5 backdrop-blur-xl
            border border-white/10
            text-slate-100 placeholder-slate-400
            shadow-lg outline-none
            focus:ring-2 focus:ring-sky-500/40
            transition-all
            resize-none
            overflow-y-auto
          "
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
              className="
                p-2 rounded-xl
                bg-slate-800/70 hover:bg-slate-700
                border border-slate-600/70
                text-slate-100 text-sm
                disabled:opacity-60
                transition-all shadow-lg
              "
              title="Subir Word/PDF del plan"
            >
              📎
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
          className="
            px-4 py-2 rounded-xl text-sm font-medium
            bg-sky-600 hover:bg-sky-500
            disabled:opacity-60
            transition-all shadow-lg
          "
        >
          Enviar
        </button>
      </div>
    </form>
  );
}
