"use client";

// Avance de la cohorte por etapa: cuántos estudiantes tienen cada etapa cerrada (stageTotals de
// GET /api/teacher/dashboard). Cada etapa se cuenta por separado: no son secuenciales (E1 se
// puede saltar), así que no se suma un "progreso total".

import { DASHBOARD_STAGES, type DashboardStageKey } from "@/lib/teacher/dashboard/aggregate";
import {
  formatPercent,
  stageKey,
  stageLabel,
  stageName,
  stagePercent,
} from "@/lib/teacher/dashboard/view";

export function StageProgressList({
  stageTotals,
  totalStudents,
}: {
  stageTotals: Record<DashboardStageKey, number>;
  totalStudents: number;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h3 className="text-sm font-semibold text-slate-100">Avance por etapa</h3>
        <p className="text-[11px] text-slate-500">
          Estudiantes con la etapa cerrada. Cada etapa se cuenta por separado.
        </p>
      </div>

      <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
        {DASHBOARD_STAGES.map((stage) => {
          const count = stageTotals[stageKey(stage)] ?? 0;
          const percent = stagePercent(count, totalStudents);

          return (
            <li key={stage} title={stageLabel(stage)}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-slate-100">E{stage}</span>{" "}
                  <span className="text-slate-400">{stageName(stage)}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-200">
                  {count}/{totalStudents}{" "}
                  <span className="text-slate-500">{formatPercent(percent)}</span>
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800/80"
                role="progressbar"
                aria-label={`${stageLabel(stage)}: ${count} de ${totalStudents}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? 0}
              >
                <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${percent ?? 0}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
