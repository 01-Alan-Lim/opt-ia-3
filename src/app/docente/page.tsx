"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { CohortsPanel } from "@/components/teacher/CohortsPanel";

type Student = {
  user_id: string;
  email: string | null;
  ru: string | null;
  first_name: string | null;
  last_name: string | null;
  semester: string | null;
  company_name: string | null;
  registration_status: string | null;
  cohort_id: string | null;
};

type Cohort = {
  id: string;
  name: string;
};

export default function DocenteHome() {
  const [token, setToken] = useState<string | null>(null);
  const authHeaders = useMemo<HeadersInit>(() => {
    const h: HeadersInit = {};
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }, [token]);

  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");

  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortId, setCohortId] = useState<string>("");

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // Load token
  useEffect(() => {
    let active = true;

    async function load() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setToken(data.session?.access_token ?? null);
    }

    load();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setToken(s?.access_token ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Load cohorts (activas)
  useEffect(() => {
    if (!token) return;

    let active = true;

    (async () => {
      try {
        const res = await fetch("/api/cohorts/active", { headers: authHeaders });
        const json = await res.json().catch(() => null);

        if (!active) return;

        if (!res.ok || json?.ok === false) {
          // no bloqueamos el panel por esto
          setCohorts([]);
          return;
        }

        const payload = json?.data ?? json;
        const list = Array.isArray(payload?.cohorts) ? payload.cohorts : [];
        setCohorts(list.map((c: any) => ({ id: c.id, name: c.name })));

        if (!cohortId && list.length) setCohortId(list[0].id);
      } catch {
        // ignore
      }
    })();

    return () => {
      active = false;
    };
  }, [token, authHeaders, cohortId]);

  async function loadStudents() {
    if (!token) return;
    setLoading(true);
    setErrorMsg(null);
    setInfoMsg(null);

    try {
      const params = new URLSearchParams();
      params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      if (cohortId) params.set("cohortId", cohortId);

      const res = await fetch(`/api/teacher/students?${params.toString()}`, {
        headers: authHeaders,
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        setErrorMsg(json?.message ?? "No se pudo cargar estudiantes.");
        setStudents([]);
        return;
      }

      const payload = json?.data ?? json;
      setStudents(Array.isArray(payload?.students) ? payload.students : []);
    } catch {
      setErrorMsg("Error de red al cargar estudiantes.");
      setStudents([]);
    } finally {
      setLoading(false);
    }
  }

  // initial load
  useEffect(() => {
    if (!token) return;
    loadStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status, cohortId]);

  async function act(user_id: string, next: "approved" | "rejected") {
    if (!token) return;
    setActingId(user_id);
    setErrorMsg(null);
    setInfoMsg(null);

    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch("/api/teacher/students/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id, status: next }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        setErrorMsg(json?.message ?? "No se pudo actualizar el estado.");
        return;
      }

      setInfoMsg(next === "approved" ? "Estudiante aprobado." : "Estudiante rechazado.");
      // refrescar lista
      await loadStudents();
    } catch {
      setErrorMsg("Error de red al actualizar estado.");
    } finally {
      setActingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 px-6 py-10">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Panel de Docente – OPT-IA</h1>
        <p className="text-sm text-slate-300 mb-6">
          MVP: aprobar registros de estudiantes. (Luego conectamos métricas, rendimiento y exportables).
        </p>

        {!token && (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-200">
            No hay sesión. Inicia sesión como docente.
          </div>
        )}

        {token && (
          <>
            <CohortsPanel />
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4 mb-5">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs text-slate-400">Estado</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as any)}
                    className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="pending">Pendientes</option>
                    <option value="approved">Aprobados</option>
                    <option value="rejected">Rechazados</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-slate-400">Cohorte</label>
                  <select
                    value={cohortId}
                    onChange={(e) => setCohortId(e.target.value)}
                    className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
                  >
                    {cohorts.length === 0 ? (
                      <option value="">(sin cohortes activas)</option>
                    ) : (
                      cohorts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="text-xs text-slate-400">Buscar (RU / nombre / email)</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      className="w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
                      placeholder="Ej: 20201234 o Alan"
                    />
                    <button
                      onClick={loadStudents}
                      className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm"
                    >
                      Buscar
                    </button>
                  </div>
                </div>
              </div>

              {errorMsg && (
                <div className="mt-4 rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">
                  {errorMsg}
                </div>
              )}
              {infoMsg && (
                <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-200">
                  {infoMsg}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/20 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <p className="text-sm text-slate-300">
                  {loading ? "Cargando..." : `Resultados: ${students.length}`}
                </p>
                <button
                  onClick={loadStudents}
                  className="rounded bg-slate-800 hover:bg-slate-700 px-3 py-1 text-sm"
                >
                  Refrescar
                </button>
              </div>

              <div className="divide-y divide-slate-800">
                {students.map((s) => {
                  const name = [s.first_name, s.last_name].filter(Boolean).join(" ");
                  const subtitle = [
                    s.ru ? `RU: ${s.ru}` : null,
                    s.semester ? `Sem: ${s.semester}` : null,
                    s.company_name ? `Emp: ${s.company_name}` : null,
                  ]
                    .filter(Boolean)
                    .join(" • ");

                  return (
                    <div key={s.user_id} className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-100">
                          {name || s.email || s.user_id}
                        </p>
                        <p className="text-xs text-slate-400">{subtitle || "Sin datos de registro aún."}</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          status: <b>{String(s.registration_status ?? "null")}</b>
                        </p>
                      </div>

                      <div className="flex gap-2">
                        <button
                          disabled={actingId === s.user_id}
                          onClick={() => act(s.user_id, "approved")}
                          className="rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-60 px-3 py-2 text-sm"
                        >
                          Aprobar
                        </button>
                        <button
                          disabled={actingId === s.user_id}
                          onClick={() => act(s.user_id, "rejected")}
                          className="rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-60 px-3 py-2 text-sm"
                        >
                          Rechazar
                        </button>
                      </div>
                    </div>
                  );
                })}

                {!loading && students.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">
                    No hay estudiantes para este filtro.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
