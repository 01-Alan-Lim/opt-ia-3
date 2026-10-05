// src/components/chat/ModeSelector.tsx
"use client";

interface ModeSelectorProps {
  mode: "general" | "plan_mejora";
  onSelectGeneral: () => void;
  onSelectPlanMejora: () => void;
}

// Selector de modo del chat. Qué hace cambiar de modo (refs, estado, chat del asesor) lo decide
// page.tsx en los callbacks.
export function ModeSelector({ mode, onSelectGeneral, onSelectPlanMejora }: ModeSelectorProps) {
  return (
    <div className="mb-0 flex flex-wrap gap-2 text-[11px]">
      <span className="mt-1 mr-2 text-[color:var(--muted)]">Modo:</span>

      <button
        type="button"
        onClick={onSelectGeneral}
        className={`px-3 py-1 rounded-full border text-xs transition ${
          mode === "general"
            ? "bg-[color:var(--primary)] border-[color:var(--primary)] text-[color:var(--primary-foreground)]"
            : "bg-transparent border-[color:var(--border)] text-[color:var(--muted)] hover:bg-[color:var(--surface)]"
        }`}
      >
        Asistente general
      </button>

      <button
        type="button"
        onClick={onSelectPlanMejora}
        className={`px-3 py-1 rounded-full border text-xs transition ${
          mode === "plan_mejora"
            ? "bg-[color:var(--primary)] border-[color:var(--primary)] text-[color:var(--primary-foreground)]"
            : "bg-transparent border-[color:var(--border)] text-[color:var(--muted)] hover:bg-[color:var(--surface)]"
        }`}
      >
        Asesor de Plan de Mejora
      </button>
    </div>
  );
}
