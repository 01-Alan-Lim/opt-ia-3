"use client";

// Vistas analíticas del Dashboard docente sobre UNA respuesta de GET /api/teacher/dashboard:
// Resumen, Evolución, Etapas y Estudiantes, con el filtro de periodo de referencia (ventanas de
// avance). El periodo solo afecta lo temporal; el estado actual (tarjetas, avance E0-E10,
// matriz) no se filtra.

import { useState } from "react";

import type { TeacherDashboard } from "@/lib/teacher/dashboard/aggregate";
import type { AdvanceWindow } from "@/lib/teacher/dashboard/analytics";
import { findWindow, formatCount, formatDateRange, type PeriodFilter } from "@/lib/teacher/dashboard/analyticsView";
import { formatHours } from "@/lib/teacher/dashboard/view";

import { BreakdownText } from "./charts";
import { DashboardFilters, viewPanelId, viewTabId, type DashboardView } from "./DashboardFilters";
import { EvolutionView } from "./EvolutionView";
import { StageAnalysisView } from "./StageAnalysisView";
import { StudentsProgressTable } from "./StudentsProgressTable";
import { SummaryView } from "./SummaryView";

function PeriodSummary({ window }: { window: AdvanceWindow }) {
  const { validations, hours, activity } = window.summary;
  return (
    <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">
          {window.label} · {formatDateRange(window.from, window.to)}
        </h3>
        <span className="text-[11px] text-slate-500">Periodo de referencia, no de cumplimiento</span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-[11px] text-slate-500">Etapas validadas en el periodo</dt>
          <dd>
            <span className="font-semibold text-slate-100">{validations.total}</span>
            <span className="block text-xs">
              <BreakdownText byStage={validations.byStage} />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Horas registradas (semanas que inician en el periodo)</dt>
          <dd>
            <span className="font-semibold text-slate-100">{formatHours(hours.totalHours)}</span>
            {hours.entries > 0 ? (
              <span className="block text-xs text-slate-400">
                {hours.entries} registros de {hours.studentsWithRecords} estudiantes
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Actividad durante el periodo (días UTC)</dt>
          <dd>
            <span className="font-semibold text-slate-100">{formatCount(activity.studentMessages)}</span>{" "}
            <span className="text-slate-400">mensajes</span>
            <span className="block text-xs text-slate-400">{activity.activeStudents} estudiantes activos</span>
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">
        Las tarjetas, el avance E0–E10 y la matriz de estudiantes muestran el estado actual: el periodo
        no los filtra.
      </p>
    </section>
  );
}

export function DashboardViews({ data }: { data: TeacherDashboard }) {
  const [view, setView] = useState<DashboardView>("summary");
  const [periodChoice, setPeriodChoice] = useState<PeriodFilter>("all");
  // Una ventana que la cohorte no tiene (p. ej., tras cambiar de cohorte) vale "periodo completo".
  const selectedWindow = findWindow(data.analytics, periodChoice);
  const period: PeriodFilter = selectedWindow ? periodChoice : "all";

  return (
    <div className="space-y-5">
      <DashboardFilters
        analytics={data.analytics}
        view={view}
        period={period}
        onViewChange={setView}
        onPeriodChange={setPeriodChoice}
      />

      {selectedWindow && <PeriodSummary window={selectedWindow} />}

      <div role="tabpanel" id={viewPanelId(view)} aria-labelledby={viewTabId(view)}>
        {view === "summary" && <SummaryView data={data} selectedWindow={selectedWindow} />}
        {view === "evolution" && <EvolutionView data={data} selectedWindow={selectedWindow} />}
        {view === "stages" && <StageAnalysisView data={data} selectedWindow={selectedWindow} />}
        {view === "students" && <StudentsProgressTable students={data.students} />}
      </div>
    </div>
  );
}
