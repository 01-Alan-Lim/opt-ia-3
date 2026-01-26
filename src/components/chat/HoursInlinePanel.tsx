"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

type SavedInfo = {
  period_start: string;
  period_end: string;
};

export function HoursInlinePanel({ onClose }: { onClose: () => void }) {
  const [hours, setHours] = useState<number>(0);
  const [activity, setActivity] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [savedInfo, setSavedInfo] = useState<SavedInfo | null>(null);

  const canSubmit = useMemo(() => {
    return Number.isFinite(hours) && hours >= 0 && hours <= 200 && activity.trim().length >= 3;
  }, [hours, activity]);

  async function getToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function submit() {
    setMsg("");
    setSavedInfo(null);
    setLoading(true);

    try {
      const token = await getToken();
      if (!token) {
        setMsg("No encuentro tu sesión. Cierra sesión y vuelve a iniciar.");
        return;
      }

      const res = await fetch("/api/hours", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ hours, activity }),
      });

      const json = await res.json().catch(() => null);

      if (res.status === 409) {
        setMsg("Ya registraste tus horas para esta semana.");
        return;
      }

      if (!res.ok || json?.ok === false) {
        setMsg(json?.message ?? "No se pudo registrar horas.");
        return;
      }

      const period = json?.data?.period ?? null;
      if (period?.period_start && period?.period_end) {
        setSavedInfo({ period_start: period.period_start, period_end: period.period_end });
      }

      setMsg("Guardado ✅");
      setHours(0);
      setActivity("");
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  // Limpia mensaje al abrir
  useEffect(() => {
    setMsg("");
    setSavedInfo(null);
  }, []);

  return (
    <div className="w-full flex justify-start">
      {/* “Bubble” del asistente, chiquito */}
      <div className="max-w-[520px] w-full rounded-2xl border border-white/12 bg-white/10 backdrop-blur-xl shadow-x1 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-100">Registrar horas (semanal)</div>
            <div className="text-xs text-slate-300 mt-0.5">
              Ingresa el total de horas y actividades realizadas en la semana.
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 border border-white/10"
          >
            Cerrar
          </button>
        </div>

        <div className="mt-3 grid gap-2">
          <label className="text-xs text-slate-300">
            Horas
            <input
              type="number"
              min={0}
              max={200}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="mt-1 w-full rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500/60"
            />
          </label>

          <label className="text-xs text-slate-300">
            Actividad realizada
            <textarea
              rows={2}
              value={activity}
              onChange={(e) => setActivity(e.target.value)}
              className="mt-1 w-full rounded-lg bg-black/20 border border-white/10 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500/60"
            />
          </label>

          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              disabled={loading || !canSubmit}
              onClick={submit}
              className="rounded-lg px-3 py-2 text-sm font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Guardando..." : "Guardar"}
            </button>

          </div>

          {savedInfo ? (
            <div className="text-xs text-slate-200 mt-1">
              Periodo guardado:{" "}
              <span className="font-semibold">
                {savedInfo.period_start} → {savedInfo.period_end}
              </span>
            </div>
          ) : null}

          {msg ? (
            <div className="mt-2 text-xs rounded-lg px-3 py-2 bg-black/30 border border-white/10 text-slate-100">
              {msg}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
