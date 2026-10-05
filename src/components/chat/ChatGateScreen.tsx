// src/components/chat/ChatGateScreen.tsx
"use client";

// Pantallas que el chat muestra antes de la interfaz: mientras se resuelve la sesión o el
// acceso, y cuando el acceso está restringido. Cuándo se muestra cada una lo decide page.tsx.

interface ChatGateLoadingProps {
  message: string;
}

export function ChatGateLoading({ message }: ChatGateLoadingProps) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[color:var(--background)] text-[color:var(--foreground)]">
      <p className="text-sm text-slate-300">{message}</p>
    </main>
  );
}

interface ChatAccessDeniedProps {
  message: string | null;
  onBack: () => void;
}

export function ChatAccessDenied({ message, onBack }: ChatAccessDeniedProps) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[color:var(--background)] text-[color:var(--foreground)]">
      <div className="max-w-md w-full mx-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-lg font-semibold mb-2">Acceso restringido</h1>
        <p className="text-sm text-slate-300 mb-4">
          {message ??
            "Debes iniciar sesión con un correo institucional autorizado para usar OPT-IA."}
        </p>
        <button
          className="w-full rounded bg-slate-800 px-3 py-2 hover:bg-slate-700 text-sm"
          onClick={onBack}
        >
          Volver al inicio
        </button>
      </div>
    </main>
  );
}
