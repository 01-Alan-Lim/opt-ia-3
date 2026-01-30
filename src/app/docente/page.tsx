//src/app/docente/page.tsx
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

type DocenteTab = "config" | "approvals" | "dashboard" | "chat";

function Icon({
  name,
  active,
}: {
  name: "config" | "approvals" | "dashboard" | "chat";
  active: boolean;
}) {
  const cls =
    "h-5 w-5 block align-middle " +
    (active ? "text-slate-100" : "text-slate-300 group-hover:text-slate-100");

  function nudge(name: "config" | "approvals" | "dashboard" | "chat") {
    // Ajuste óptico (se puede afinar)
    if (name === "config") return "translate-y-[1px]";
    return "translate-y-0";
  }

  // SVGs inline (sin librerías)
  if (name === "config") {
    return (
      <svg className={`${cls} ${nudge("config")}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 7h12M6 17h12M6 12h12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M9 7v0M15 12v0M12 17v0"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
    );
  }


  if (name === "approvals") {
    return (
      <svg className={`${cls} ${nudge("approvals")}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M9 12l2 2 4-5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (name === "dashboard") {
    return (
      <svg className={`${cls} ${nudge("dashboard")}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 19V5m0 14h16"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M7 16v-5M11 16V8M15 16v-3M19 16V10"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // chat
  return (
    <svg className={`${cls} ${nudge("chat")}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 18l-3 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 8h8M8 12h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: "config" | "approvals" | "dashboard" | "chat";
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title} // tooltip nativo en colapsado
      className={[
        "group/nav w-full rounded-2xl transition relative overflow-hidden",
        active ? "bg-slate-900/25" : "bg-transparent hover:bg-slate-900/20",
      ].join(" ")}
    >
      <div className="flex items-center justify-center py-2 px-0 group-hover/sidebar:justify-start group-hover/sidebar:px-3 gap-3">
        {/* Icon pill: centrado siempre */}
        <div
          className={[
            "h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center transition",
            "border border-slate-800/80",
            active ? "bg-slate-900/30" : "bg-slate-950/35",
          ].join(" ")}
        >
          <Icon name={icon} active={active} />
        </div>

        {/* Texto solo en hover del sidebar */}
        <div className="hidden group-hover/sidebar:block min-w-0 text-left">
          <div className="text-sm font-medium text-slate-100 truncate">{title}</div>
          <div className="text-[11px] text-slate-400 truncate">{subtitle}</div>
        </div>
      </div>
    </button>
  );
}

function NotImplemented({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-6">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      <p className="mt-2 text-sm text-slate-300">
        NO IMPLEMENTADO en el ZIP actual.
        {hint ? <span className="text-slate-400"> {hint}</span> : null}
      </p>
    </div>
  );
}

export default function DocenteHome() {
  const [token, setToken] = useState<string | null>(null);
  const [tab, setTab] = useState<DocenteTab>("config");

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

  // Load cohorts (activas) — solo cuando estamos en Aprobaciones
  useEffect(() => {
    if (!token) return;
    if (tab !== "approvals") return;

    let active = true;

    (async () => {
      try {
        const res = await fetch("/api/cohorts/active", { headers: authHeaders });
        const json = await res.json().catch(() => null);

        if (!active) return;

        if (!res.ok || json?.ok === false) {
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
  }, [token, authHeaders, cohortId, tab]);

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

  // initial load — solo en Aprobaciones
  useEffect(() => {
    if (!token) return;
    if (tab !== "approvals") return;
    loadStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status, cohortId, tab]);

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
      await loadStudents();
    } catch {
      setErrorMsg("Error de red al actualizar estado.");
    } finally {
      setActingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 py-10 px-6 md:pl-[92px]">
      <div className="w-full max-w-none">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Panel de Docente – OPT-IA</h1>
          <p className="mt-1 text-sm text-slate-300">
            MVP: aprobar registros de estudiantes. (Luego conectamos métricas, rendimiento y exportables).
          </p>
        </div>

        {!token && (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-200">
            No hay sesión. Inicia sesión como docente.
          </div>
        )}

        {token && (
          <div className="flex flex-col gap-5">
            {/* Navegación */}
            <aside
              className={[
                "group/sidebar hidden md:block",
                "fixed left-0 top-0 h-screen z-30",
                "w-[68px] hover:w-72 transition-[width] duration-200",
                "border-r border-slate-800/60",
                "bg-slate-950/70",
                "shadow-[inset_-20px_0_40px_rgba(0,0,0,0.35)]",
                "backdrop-blur",
                "overflow-hidden",
              ].join(" ")}
            >
              <div className="absolute inset-0 pointer-events-none z-0 bg-[linear-gradient(90deg,rgba(56,189,248,0.08),transparent_35%,transparent_65%,rgba(56,189,248,0.06))]" />
              <div className="h-full px-2 py-4 relative z-10">
                {/* Contenedor limpio (sin caja gigante en colapsado) */}
                <div className="h-full flex flex-col items-center">
                  {/* “Logo” minimal arriba (sin •••) */}
                  <div className="mb-5 w-full px-0 group-hover/sidebar:px-3 transition-[padding] duration-200">
                    <div className="h-10 flex items-center">
                      {/* COLAPSADO: solo OPT (sin círculo) */}
                      <div className="w-full flex items-center justify-center group-hover/sidebar:hidden">
                        <span className="text-xs font-semibold tracking-[0.25em] text-slate-200">
                          OPT
                        </span>
                      </div>

                      {/* EXPANDIDO: solo texto OPT-IA / Panel Docente */}
                      <div className="hidden group-hover/sidebar:flex w-full items-center justify-center">
                        <div className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            <div className="text-sm font-semibold text-slate-100 leading-tight">
                              OPT-IA
                            </div>
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                          </div>
                          <div className="text-[11px] text-slate-400 leading-tight">
                            Panel Docente
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>


                  {/* Navegación */}
                  <nav className="w-full space-y-2">
                    <NavItem
                      active={tab === "config"}
                      onClick={() => setTab("config")}
                      icon="config"
                      title="Configuración"
                      subtitle="Cohortes, fechas, formularios"
                    />
                    <NavItem
                      active={tab === "approvals"}
                      onClick={() => setTab("approvals")}
                      icon="approvals"
                      title="Aprobaciones"
                      subtitle="Revisar registros"
                    />
                    <NavItem
                      active={tab === "dashboard"}
                      onClick={() => setTab("dashboard")}
                      icon="dashboard"
                      title="Dashboard"
                      subtitle="Indicadores y reportes"
                    />
                    <NavItem
                      active={tab === "chat"}
                      onClick={() => setTab("chat")}
                      icon="chat"
                      title="Chat"
                      subtitle="Consulta rendimiento"
                    />
                  </nav>

                  {/* Spacer */}
                  <div className="flex-1" />
                </div>
              </div>
            </aside>

            {/* Contenido */}
            <section className="flex-1 min-w-0">
              {tab === "config" && <CohortsPanel />}

              {tab === "approvals" && (
                <>
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
                          <div
                            key={s.user_id}
                            className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-100 truncate">
                                {name || s.email || s.user_id}
                              </p>
                              <p className="text-xs text-slate-400 truncate">
                                {subtitle || "Sin datos de registro aún."}
                              </p>
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

              {tab === "dashboard" && (
                <NotImplemented
                  title="Dashboard"
                  hint="Aquí irá el panel de indicadores, reportes por estudiante y exportables."
                />
              )}

              {tab === "chat" && (
                <NotImplemented
                  title="Chat Docente"
                  hint="Aquí irá un chat para consultar rendimiento/resumen del estudiante sin leer chats largos."
                />
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
