"use client";

// Dashboard docente: una cohorte a la vez (por defecto la más reciente), con selector de
// cohorte y las vistas analíticas (DashboardViews: Resumen, Evolución, Etapas, Estudiantes).
// Solo pinta lo que devuelve GET /api/teacher/dashboard; no calcula métricas académicas.

import type { ReactNode } from "react";

import type { TeacherDashboard as TeacherDashboardData } from "@/lib/teacher/dashboard/aggregate";
import type { CohortOption } from "@/lib/teacher/dashboard/view";

import { DashboardViews } from "./DashboardViews";
import { useCohortDashboard } from "./useCohortDashboard";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("es-BO");
}

function cohortSubtitle(cohort: TeacherDashboardData["cohort"]): string {
  const parts = [cohort.name, cohort.isActive ? "Activa" : "Inactiva"];
  const starts = formatDate(cohort.accessStartsAt);
  const ends = formatDate(cohort.accessEndsAt);
  if (starts || ends) parts.push(`Acceso: ${starts ?? "—"} → ${ends ?? "—"}`);
  return parts.join(" · ");
}

function Notice({ tone = "neutral", children }: { tone?: "neutral" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-red-900/40 bg-red-950/30 text-red-200"
      : "border-slate-800 bg-slate-900/30 text-slate-300";
  return <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export function CohortProgressDashboard() {
  const { cohortId, cohorts, state, selectCohort, reload } = useCohortDashboard();
  const data = state.status === "ready" ? state.data : null;

  // Opciones del selector: la lista de cohortes; si no llegó, al menos la cohorte cargada.
  const options: CohortOption[] =
    data && !cohorts.some((cohort) => cohort.id === data.cohort.id)
      ? [{ id: data.cohort.id, name: data.cohort.name, isActive: data.cohort.isActive }, ...cohorts]
      : cohorts;
  const selectedId = cohortId ?? data?.cohort.id ?? "";

  if (state.status === "denied") {
    return <Notice tone="error">No tienes acceso al panel docente.</Notice>;
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-100">Panel de seguimiento</h2>
          <p className="mt-1 truncate text-sm text-slate-400">
            {data ? cohortSubtitle(data.cohort) : "Cohorte más reciente"}
          </p>
        </div>

        {options.length > 0 && (
          <label className="block w-full md:w-72">
            <span className="mb-1 block text-xs text-slate-400">Cohorte</span>
            <select
              value={selectedId}
              onChange={(e) => {
                if (e.target.value) selectCohort(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
            >
              {!selectedId && (
                <option value="" disabled>
                  Cargando...
                </option>
              )}
              {options.map((cohort) => (
                <option key={cohort.id} value={cohort.id}>
                  {cohort.name}
                  {cohort.isActive ? " (activa)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {state.status === "loading" && <Notice>Cargando panel...</Notice>}

      {state.status === "empty" && <Notice>{state.message}</Notice>}

      {state.status === "error" && (
        <Notice tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{state.message}</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-lg border border-red-800/60 px-3 py-1.5 text-xs text-red-100 hover:bg-red-950/50"
            >
              Reintentar
            </button>
          </div>
        </Notice>
      )}

      {data && <DashboardViews data={data} />}
    </section>
  );
}
