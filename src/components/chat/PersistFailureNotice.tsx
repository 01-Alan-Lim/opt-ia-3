"use client";

// Aviso discreto, sobre el campo de texto, de mensajes que no se guardaron en el historial
// (R1-E). No bloquea el chat: los mensajes siguen visibles y se puede seguir escribiendo.

import type { PersistFailureNoticeModel } from "@/app/chat/_lib/persistFailures";

type Props = {
  notice: PersistFailureNoticeModel | null;
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
};

export function PersistFailureNotice({ notice, retrying, onRetry, onDismiss }: Props) {
  if (!notice) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-xs sm:text-sm text-[color:var(--foreground)] shadow-sm"
    >
      <span aria-hidden="true">⚠️</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        {notice.pendingText && <p>{notice.pendingText}</p>}
        {notice.rejectedText && <p className="text-[color:var(--muted)]">{notice.rejectedText}</p>}
      </div>
      {notice.canRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="rounded-lg border border-[color:var(--border)] px-2.5 py-1 font-medium hover:bg-[color:var(--surface-elevated)] disabled:opacity-60"
        >
          {retrying ? "Guardando…" : "Reintentar"}
        </button>
      )}
      {notice.canDismiss && !notice.canRetry && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg px-2 py-1 text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
          aria-label="Cerrar aviso"
        >
          Cerrar
        </button>
      )}
    </div>
  );
}
