// src/components/chat/ChatHeader.tsx
"use client";

import Image from "next/image";

interface ChatHeaderProps {
  theme: "dark" | "light";
  displayName: string;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}

// Barra superior interna del chat: botón del historial, logo, cambio de tema y nombre del usuario.
export function ChatHeader({ theme, displayName, onToggleSidebar, onToggleTheme }: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3 text-[11px] text-[color:var(--muted)]">
      {/* Bloque: 3 rayas + logo + título */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="mr-1 rounded-full p-2 text-base transition-colors
            text-[color:var(--foreground)] hover:bg-[color:var(--surface)]"
        >
          ☰
        </button>

        <Image src="/logo-opt.png" alt="Logo OPT-IA" width={28} height={28} className="rounded-full" />

        <div className="flex flex-col">
          <span className="text-xs font-semibold text-[color:var(--foreground)]">OPT-IA</span>
          <span className="text-[11px] text-[color:var(--muted)]">Asistente para estudiantes</span>
        </div>
      </div>

      {/* Usuario + logout + theme */}
      <div className="flex items-center gap-2 mr-4">
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded-full p-2 hover:bg-[color:var(--surface)] transition-colors"
          title={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
          aria-label="Cambiar tema"
        >
          {theme === "dark" ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>

        <span className="hidden sm:inline text-[14px] text-[color:var(--muted)]">{displayName}</span>
      </div>

    </div>
  );
}
