"use client";

// Pestaña Dashboard de /docente. Dos vistas: "Resumen" (panel nativo, la inicial) y "Looker"
// (el informe de Looker Studio, secundario hasta validar el nativo). El resumen queda montado
// al cambiar de vista para no perder la cohorte ni los filtros; el iframe solo se carga si se
// elige Looker.

import { useState } from "react";

import { CohortProgressDashboard } from "./dashboard/CohortProgressDashboard";
import { LookerReport } from "./dashboard/LookerReport";

type DashboardView = "summary" | "looker";

const VIEWS: Array<{ id: DashboardView; label: string }> = [
  { id: "summary", label: "Resumen" },
  { id: "looker", label: "Looker" },
];

export function TeacherDashboard() {
  const [view, setView] = useState<DashboardView>("summary");

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Vista del dashboard"
        className="inline-flex rounded-xl border border-slate-800 bg-slate-950/40 p-1"
      >
        {VIEWS.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(item.id)}
              className={[
                "rounded-lg px-4 py-1.5 text-sm transition",
                active ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200",
              ].join(" ")}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div hidden={view !== "summary"}>
        <CohortProgressDashboard />
      </div>

      {view === "looker" && <LookerReport />}
    </div>
  );
}
