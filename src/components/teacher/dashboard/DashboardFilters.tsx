"use client";

// Barra superior de las vistas del Dashboard docente: pestañas Resumen / Evolución / Etapas /
// Estudiantes y el filtro de periodo por ventanas de avance (analytics.advanceWindows). Las
// ventanas son periodos de REFERENCIA: no dicen si alguien cumplió un avance.

import type { DashboardAnalytics } from "@/lib/teacher/dashboard/analytics";
import { periodOptions, windowsNotice, type PeriodFilter } from "@/lib/teacher/dashboard/analyticsView";

export type DashboardView = "summary" | "evolution" | "stages" | "students";

export const DASHBOARD_VIEWS: ReadonlyArray<{ value: DashboardView; label: string; question: string }> = [
  { value: "summary", label: "Resumen", question: "¿Cómo está la cohorte?" },
  { value: "evolution", label: "Evolución", question: "¿Cómo evolucionó en el tiempo?" },
  { value: "stages", label: "Etapas", question: "¿Dónde está el cuello de botella?" },
  { value: "students", label: "Estudiantes", question: "¿Quién necesita revisión?" },
];

export function viewTabId(view: DashboardView): string {
  return `teacher-dashboard-tab-${view}`;
}

export function viewPanelId(view: DashboardView): string {
  return `teacher-dashboard-panel-${view}`;
}

export function DashboardFilters({
  analytics,
  view,
  period,
  onViewChange,
  onPeriodChange,
}: {
  analytics: DashboardAnalytics;
  view: DashboardView;
  period: PeriodFilter;
  onViewChange: (view: DashboardView) => void;
  onPeriodChange: (period: PeriodFilter) => void;
}) {
  const options = periodOptions(analytics);
  const notice = windowsNotice(analytics.advanceWindows.status);
  const current = DASHBOARD_VIEWS.find((item) => item.value === view);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Vistas del panel"
          className="inline-flex w-full flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/40 p-1 sm:w-auto"
        >
          {DASHBOARD_VIEWS.map((item) => {
            const selected = item.value === view;
            return (
              <button
                key={item.value}
                id={viewTabId(item.value)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={viewPanelId(item.value)}
                onClick={() => onViewChange(item.value)}
                className={[
                  "flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors sm:flex-none",
                  selected
                    ? "bg-sky-600/25 font-medium text-slate-100 ring-1 ring-inset ring-sky-500/30"
                    : "text-slate-400 hover:bg-slate-900 hover:text-slate-200",
                ].join(" ")}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {current ? <p className="text-xs text-slate-500">{current.question}</p> : null}
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs text-slate-400">Periodo de referencia</legend>
        <div role="radiogroup" aria-label="Periodo de referencia" className="flex flex-wrap gap-2">
          {options.map((option) => {
            const selected = option.value === period;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={option.disabled}
                onClick={() => onPeriodChange(option.value)}
                className={[
                  "min-w-[8.5rem] flex-1 rounded-lg border px-3 py-1.5 text-left transition-colors sm:flex-none",
                  selected
                    ? "border-sky-500/50 bg-sky-500/10"
                    : "border-slate-800 bg-slate-950/40 hover:border-slate-700",
                  option.disabled ? "cursor-not-allowed opacity-40 hover:border-slate-800" : "",
                ].join(" ")}
              >
                <span className={`block text-sm ${selected ? "text-slate-100" : "text-slate-300"}`}>
                  {option.label}
                </span>
                <span className="block text-[11px] text-slate-500">{option.detail}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {notice ??
            "Las ventanas de avance son periodos de referencia de la cohorte: no indican si un estudiante cumplió el avance."}
        </p>
      </fieldset>
    </div>
  );
}
