"use client";

// Panel docente de la cuenta organizadora de Google Calendar (pestaña Configuración). Desde aquí
// se conecta la cuenta que envía las invitaciones a los estudiantes aprobados; los estudiantes no
// hacen nada. El navegador solo ve el estado: los tokens quedan en el servidor
// (/api/teacher/calendar-organizer, solo docentes).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { calendarReportText, type CalendarReportLike } from "@/lib/calendar/syncReportText";

type OrganizerState = {
  available: boolean;
  configured: { oauth: boolean; encryptionKey: boolean };
  status: "connected" | "disconnected" | "not_connected";
  googleEmail: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  invitations: { invited: number; cancelled: number; withErrors: number } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("es-BO", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const BADGE: Record<OrganizerState["status"], { text: string; className: string }> = {
  connected: { text: "Conectado", className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-200" },
  disconnected: { text: "Desconectado", className: "border-rose-800/50 bg-rose-950/40 text-rose-200" },
  not_connected: { text: "Sin conectar", className: "border-slate-700 bg-slate-900/60 text-slate-300" },
};

export function CalendarOrganizerPanel() {
  const router = useRouter();
  const [state, setState] = useState<OrganizerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "connect" | "sync" | "disconnect" | "withdraw">(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const autoSynced = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/teacher/calendar-organizer", { headers: await authHeaders(), cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setErrorMsg(json?.message ?? "No se pudo leer el estado del calendario.");
        return;
      }
      setState(json.data as OrganizerState);
    } catch {
      setErrorMsg("Error de red al leer el estado del calendario.");
    } finally {
      setLoading(false);
    }
  }, []);

  const post = useCallback(async (path: string, method: "POST" | "DELETE" = "POST") => {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json", ...(await authHeaders()) } });
    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok === true, json };
  }, []);

  const sync = useCallback(async () => {
    setBusy("sync");
    setErrorMsg(null);
    setInfoMsg("Sincronizando invitaciones…");
    try {
      const { ok, json } = await post("/api/teacher/calendar-organizer/sync");
      if (!ok) {
        setInfoMsg(null);
        setErrorMsg(json?.message ?? "No se pudo sincronizar.");
        return;
      }
      const report = json?.data?.calendar as CalendarReportLike;
      if (report?.status === "ok") setInfoMsg(calendarReportText(report));
      else {
        setInfoMsg(null);
        setErrorMsg(calendarReportText(report));
      }
    } catch {
      setInfoMsg(null);
      setErrorMsg("Error de red al sincronizar.");
    } finally {
      setBusy(null);
      await load();
    }
  }, [load, post]);

  useEffect(() => {
    void load();
  }, [load]);

  // Al volver de Google con la cuenta conectada: primera sincronización y limpiar la URL.
  useEffect(() => {
    if (autoSynced.current || new URL(window.location.href).searchParams.get("calendario") !== "conectado") return;
    autoSynced.current = true;
    router.replace("/docente");
    void sync();
  }, [router, sync]);

  async function connect() {
    setBusy("connect");
    setErrorMsg(null);
    try {
      const { ok, json } = await post("/api/teacher/calendar-organizer/start");
      const url = json?.data?.url;
      if (!ok || typeof url !== "string" || !url.startsWith("https://accounts.google.com/")) {
        setErrorMsg(json?.message ?? "No se pudo iniciar la conexión con Google.");
        setBusy(null);
        return;
      }
      window.location.assign(url);
    } catch {
      setErrorMsg("Error de red al iniciar la conexión.");
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("¿Desconectar la cuenta organizadora? Las invitaciones ya enviadas se quedan en los calendarios, pero dejarán de actualizarse.")) return;
    setBusy("disconnect");
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const { ok, json } = await post("/api/teacher/calendar-organizer", "DELETE");
      if (!ok) setErrorMsg(json?.message ?? "No se pudo desconectar.");
      else setInfoMsg("Cuenta organizadora desconectada.");
    } catch {
      setErrorMsg("Error de red al desconectar.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function withdraw() {
    if (!window.confirm("¿Retirar todas las invitaciones futuras? Google avisará a cada estudiante de la cancelación. Úsalo solo antes de cambiar de cuenta organizadora.")) return;
    setBusy("withdraw");
    setErrorMsg(null);
    setInfoMsg("Retirando invitaciones…");
    try {
      const { ok, json } = await post("/api/teacher/calendar-organizer/withdraw");
      const report = json?.data?.calendar as CalendarReportLike;
      if (!ok || report?.status !== "ok") {
        setInfoMsg(null);
        setErrorMsg(ok ? calendarReportText(report) : json?.message ?? "No se pudieron retirar las invitaciones.");
      } else setInfoMsg(calendarReportText(report));
    } catch {
      setInfoMsg(null);
      setErrorMsg("Error de red al retirar invitaciones.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  const configured = Boolean(state?.configured.oauth && state?.configured.encryptionKey && state?.available);
  const badge = BADGE[state?.status ?? "not_connected"];
  const totals = state?.invitations;

  return (
    <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/30 p-4" aria-labelledby="calendar-organizer-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="calendar-organizer-title" className="text-sm font-semibold text-slate-100">
          Invitaciones de Google Calendar
        </h2>
        {state && <span className={`rounded-full border px-2.5 py-0.5 text-xs ${badge.className}`}>{badge.text}</span>}
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Una cuenta de Google de la materia envía las fechas de cada cohorte como invitaciones a los estudiantes aprobados.
        Los estudiantes no tienen que conectar nada.
      </p>

      {loading && !state && <div className="mt-3 text-sm text-slate-400">Cargando…</div>}

      {state && !configured && (
        <div className="mt-3 rounded-xl border border-amber-800/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {!state.available
            ? "El calendario no está disponible todavía: falta preparar la base de datos."
            : "Falta configurar el calendario en el servidor (cliente OAuth de Google y clave de cifrado)."}
        </div>
      )}

      {state && configured && (
        <div className="mt-3 space-y-2 text-sm">
          {state.googleEmail && (
            <div className="text-slate-200">
              Cuenta organizadora: <span className="font-medium">{state.googleEmail}</span>
            </div>
          )}
          {state.status === "connected" && (
            <div className="text-xs text-slate-400">
              {state.lastSyncedAt ? `Última sincronización: ${formatDateTime(state.lastSyncedAt)}` : "Aún no se ha sincronizado."}
              {totals ? ` · ${totals.invited} invitaciones activas` : ""}
              {totals && totals.withErrors > 0 ? ` · ${totals.withErrors} con error` : ""}
            </div>
          )}
          {state.lastError && (
            <div className="rounded-xl border border-rose-900/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
              {state.lastError}
              {state.lastErrorAt ? ` (${formatDateTime(state.lastErrorAt)})` : ""}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {state.status !== "connected" ? (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy !== null}
                className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
              >
                {busy === "connect" ? "Abriendo Google…" : state.status === "disconnected" ? "Volver a conectar" : "Conectar cuenta organizadora"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void sync()}
                  disabled={busy !== null}
                  className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
                >
                  {busy === "sync" ? "Sincronizando…" : "Sincronizar ahora"}
                </button>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={busy !== null}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-60"
                >
                  Desconectar
                </button>
                <button
                  type="button"
                  onClick={() => void withdraw()}
                  disabled={busy !== null}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-60"
                >
                  {busy === "withdraw" ? "Retirando…" : "Retirar invitaciones"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div aria-live="polite" className="mt-2 min-h-5 text-xs">
        {errorMsg && <span className="text-rose-300">{errorMsg}</span>}
        {!errorMsg && infoMsg && <span className="text-emerald-300">{infoMsg}</span>}
      </div>
    </section>
  );
}
