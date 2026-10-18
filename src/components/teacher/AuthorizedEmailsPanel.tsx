"use client";

// Panel docente de correos autorizados (pestaña Aprobaciones). Los correos institucionales
// entran solos; aquí se autorizan o revocan correos personales (p. ej. Gmail). Autorizar no
// aprueba: el estudiante completa el registro y espera la aprobación docente igual que los demás.
// Todo lo decide el servidor (/api/teacher/authorized-emails, solo docentes).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type AuthorizationItem = {
  id: string;
  email: string;
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
  registrationStatus: string | null;
};

type CalendarSummary = { status: string; cancelled?: number } | null | undefined;

const ACADEMIC_LABEL: Record<string, string> = {
  pending: "Pendiente de aprobación",
  approved: "Habilitado",
  rejected: "Rechazado",
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-BO", { day: "2-digit", month: "short", year: "numeric" });
}

function calendarText(calendar: CalendarSummary): string {
  if (!calendar) return "";
  if (calendar.status === "ok" && calendar.cancelled) return ` Se cancelaron ${calendar.cancelled} invitaciones de calendario.`;
  if (calendar.status === "organizer_not_connected") return "";
  if (calendar.status === "error" || calendar.status === "partial") return " No se pudieron cancelar todas sus invitaciones de calendario; usa Sincronizar en Configuración.";
  return "";
}

export function AuthorizedEmailsPanel() {
  const [items, setItems] = useState<AuthorizationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/teacher/authorized-emails", { headers: await authHeaders() });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setErrorMsg(json?.message ?? "No se pudieron cargar los correos autorizados.");
        return;
      }
      setItems((json?.data?.items ?? []) as AuthorizationItem[]);
    } catch {
      setErrorMsg("No se pudieron cargar los correos autorizados.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function authorize(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/teacher/authorized-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ email, note: note.trim() || null }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setErrorMsg(json?.message ?? "No se pudo autorizar el correo.");
        return;
      }
      setInfoMsg(json?.data?.created ? "Correo autorizado. Ya puede registrarse; su acceso quedará pendiente de tu aprobación." : "Ese correo ya estaba autorizado.");
      setEmail("");
      setNote("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(target: string) {
    if (!window.confirm(`¿Revocar el acceso de ${target}? No podrá entrar a OPT-IA mientras no lo vuelvas a autorizar.`)) return;
    setErrorMsg(null);
    setInfoMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/teacher/authorized-emails?email=${encodeURIComponent(target)}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setErrorMsg(json?.message ?? "No se pudo revocar el acceso.");
        return;
      }
      setInfoMsg(`Acceso revocado para ${target}.${calendarText(json?.data?.calendar as CalendarSummary)}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const visible = items.filter((i) => showRevoked || i.active);

  return (
    <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/30 p-4" aria-labelledby="authorized-emails-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="authorized-emails-title" className="text-sm font-semibold text-slate-100">
          Correos personales autorizados
        </h2>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Mostrar revocados
        </label>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Los correos institucionales entran solos. Autoriza aquí solo excepciones (p. ej. Gmail). Autorizar no aprueba:
        el estudiante completa su registro y espera tu aprobación.
      </p>

      <form onSubmit={authorize} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="correo@gmail.com"
          className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
          aria-label="Correo a autorizar"
        />
        <input
          type="text"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Motivo (opcional)"
          className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
          aria-label="Motivo"
        />
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
        >
          Autorizar
        </button>
      </form>

      <div aria-live="polite" className="mt-2 min-h-5 text-xs">
        {errorMsg && <span className="text-rose-300">{errorMsg}</span>}
        {!errorMsg && infoMsg && <span className="text-emerald-300">{infoMsg}</span>}
      </div>

      <div className="mt-2 overflow-hidden rounded-xl border border-slate-800">
        {loading && <div className="px-4 py-6 text-center text-sm text-slate-400">Cargando…</div>}
        {!loading && visible.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-slate-400">No hay correos autorizados.</div>
        )}
        {!loading &&
          visible.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-3 first:border-t-0">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-100">{item.email}</div>
                <div className="text-xs text-slate-400">
                  {item.active ? "Autorizado" : `Revocado ${item.revokedAt ? formatDate(item.revokedAt) : ""}`} ·{" "}
                  {item.registrationStatus ? ACADEMIC_LABEL[item.registrationStatus] ?? item.registrationStatus : "Aún no se registra"}
                  {item.note ? ` · ${item.note}` : ""}
                </div>
              </div>
              {item.active && (
                <button
                  type="button"
                  onClick={() => void revoke(item.email)}
                  disabled={busy}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-60"
                >
                  Revocar
                </button>
              )}
            </div>
          ))}
      </div>
    </section>
  );
}
