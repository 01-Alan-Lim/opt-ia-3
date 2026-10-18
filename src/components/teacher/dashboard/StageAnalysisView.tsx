"use client";

// Vista Etapas: ¿dónde está el cuello de botella? Para la etapa elegida: cuántos la cerraron
// (estado actual), sus primeras validaciones por mes, la distribución de notas de ESA etapa (no
// se compara con otras: las rúbricas son distintas) y quiénes la tienen pendiente. E0 no tiene
// fecha histórica ni evaluación.

import { useState } from "react";

import type { PlanStageNumber } from "@/lib/plan/stageArtifacts";
import { DASHBOARD_STAGES, type TeacherDashboard } from "@/lib/teacher/dashboard/aggregate";
import type { AdvanceWindow, DashboardAnalytics } from "@/lib/teacher/dashboard/analytics";
import {
  advanceMarkers,
  analyticsMonths,
  defaultAnalysisStage,
  formatDateRange,
  formatMonth,
  niceMax,
  scoreDistributionFor,
  scoreLabelRows,
  spanPositions,
  stageClosuresByMonth,
  stageCountKey,
} from "@/lib/teacher/dashboard/analyticsView";
import {
  formatHours,
  formatPercent,
  pendingStudentsForStage,
  stageName,
  stagePercent,
  studentDisplayName,
} from "@/lib/teacher/dashboard/view";

import { ChartCard, ChartReadout, ChartTable, HBar, MonthColumns, TimePlot } from "./charts";
import { RegistrationBadge } from "./StudentsProgressTable";

function formatScore(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("es-BO", { maximumFractionDigits: 2 });
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "done" }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
        {tone === "done" ? <span className="h-2 w-2 rounded-full bg-emerald-400/80" aria-hidden /> : null}
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function ClosuresCard({
  analytics,
  stage,
  selectedWindow,
}: {
  analytics: DashboardAnalytics;
  stage: PlanStageNumber;
  selectedWindow: AdvanceWindow | null;
}) {
  const [active, setActive] = useState<number | null>(null);

  if (stage === 0) {
    return (
      <ChartCard title="Cierres por mes" subtitle="E0 · Contexto del caso">
        <p className="text-sm text-slate-300">Fecha histórica de confirmación no disponible.</p>
        <p className="mt-1 text-[11px] text-slate-500">
          El contexto del caso no guarda cuándo se confirmó: E0 solo se muestra como estado actual.
        </p>
      </ChartCard>
    );
  }

  const months = analyticsMonths(analytics);
  const closures = stageClosuresByMonth(analytics, stage);
  const values = closures.map((item) => item.count);
  const yMax = niceMax(Math.max(0, ...values));
  const markers = advanceMarkers(months, analytics.advanceEvents);
  const band = selectedWindow ? spanPositions(months, selectedWindow.from, selectedWindow.to) : null;
  const current = active !== null ? closures[active] : null;
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <ChartCard
      title="Primeras validaciones por mes"
      subtitle={`E${stage} · ${stageName(stage)}. Estudiantes que cerraron la etapa por primera vez en cada mes.`}
      note={
        selectedWindow ? (
          <>
            En {selectedWindow.label} ({formatDateRange(selectedWindow.from, selectedWindow.to)}):{" "}
            <span className="text-slate-300">
              {selectedWindow.summary.validations.byStage[stageCountKey(stage)]}
            </span>{" "}
            primeras validaciones de E{stage}.
          </>
        ) : (
          "A1, A2, A3: fechas de referencia de los avances."
        )
      }
    >
      <ChartReadout>
        {current ? (
          <>
            <span className="font-semibold text-slate-100">{current.count}</span> en {formatMonth(current.period)}
          </>
        ) : (
          <>
            <span className="font-semibold text-slate-100">{total}</span> con fecha en todo el periodo
          </>
        )}
      </ChartReadout>
      <TimePlot
        months={months}
        yMax={yMax}
        markers={markers}
        band={band}
        height={120}
        label={`Primeras validaciones de E${stage} por mes`}
      >
        <MonthColumns
          values={values}
          yMax={yMax}
          activeIndex={active}
          onActivate={setActive}
          describe={(index) => `${formatMonth(closures[index].period)}: ${closures[index].count}`}
        />
      </TimePlot>
      <ChartTable
        caption={`Primeras validaciones de E${stage} por mes`}
        head={["Mes", "Validaciones"]}
        rows={closures.map((item) => [formatMonth(item.period), String(item.count)])}
      />
    </ChartCard>
  );
}

function ScoreCard({ analytics, stage }: { analytics: DashboardAnalytics; stage: PlanStageNumber }) {
  const distribution = scoreDistributionFor(analytics, stage);
  const title = "Notas de la etapa";
  const subtitle = `E${stage} · ${stageName(stage)}`;

  if (stage === 0 || distribution === null) {
    return (
      <ChartCard title={title} subtitle={subtitle}>
        <p className="text-sm text-slate-300">E0 no tiene evaluación: se cierra al confirmar el contexto del caso.</p>
      </ChartCard>
    );
  }

  if (distribution.count === 0) {
    return (
      <ChartCard title={title} subtitle={subtitle}>
        <p className="text-sm text-slate-300">Sin evaluación registrada.</p>
        <p className="mt-1 text-[11px] text-slate-500">
          Ningún estudiante de la cohorte tiene una evaluación guardada para esta etapa.
        </p>
      </ChartCard>
    );
  }

  const rows = scoreLabelRows(distribution);
  const max = Math.max(1, ...rows.map((row) => row.count));

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      note="Nota vigente de cada estudiante en esta etapa (0 a 100, con la rúbrica propia de la etapa). No se compara con otras etapas ni se promedia entre ellas."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Evaluados" value={String(distribution.count)} />
        <Stat label="Promedio" value={formatScore(distribution.average)} />
        <Stat label="Mínimo" value={formatScore(distribution.min)} />
        <Stat label="Máximo" value={formatScore(distribution.max)} />
      </div>
      <div className="mt-4 space-y-3">
        {rows.map((row) => (
          <HBar key={row.label} label={row.label} value={row.count} max={max} display={`${row.count} est.`} />
        ))}
      </div>
      <ChartTable
        caption={`Etiquetas de nota de E${stage}`}
        head={["Etiqueta", "Estudiantes"]}
        rows={rows.map((row) => [row.label, String(row.count)])}
      />
    </ChartCard>
  );
}

function PendingTable({ data, stage }: { data: TeacherDashboard; stage: PlanStageNumber }) {
  const [query, setQuery] = useState("");
  const allPending = pendingStudentsForStage(data.students, stage, "");
  const visible = pendingStudentsForStage(data.students, stage, query);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/20">
      <div className="flex flex-col gap-3 border-b border-slate-800 p-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Pendientes en E{stage}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {allPending.length} estudiantes sin cerrar {stageName(stage)} (estado actual).
          </p>
        </div>
        <label className="block w-full md:w-72">
          <span className="mb-1 block text-xs text-slate-400">Buscar (RU / nombre / email)</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
            placeholder="Ej: 20201234 o Juan Pérez"
          />
        </label>
      </div>

      {allPending.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-400">
          Todos los estudiantes cerraron esta etapa.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Estudiante</th>
                <th className="px-3 py-2.5 font-medium">RU</th>
                <th className="px-3 py-2.5 font-medium">Estado</th>
                <th className="px-3 py-2.5 text-right font-medium">Horas</th>
                <th className="px-4 py-2.5 font-medium">E{stage}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {visible.map((student) => (
                <tr key={student.userId} className="hover:bg-slate-900/40">
                  <td className="max-w-[240px] truncate px-4 py-2 font-medium text-slate-100">
                    {studentDisplayName(student)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-300">{student.ru ?? "—"}</td>
                  <td className="px-3 py-2">
                    <RegistrationBadge status={student.registrationStatus} />
                  </td>
                  <td
                    className={[
                      "whitespace-nowrap px-3 py-2 text-right tabular-nums",
                      student.hours.total === null ? "text-[11px] text-slate-500" : "text-slate-200",
                    ].join(" ")}
                  >
                    {formatHours(student.hours.total)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-[11px] text-slate-400">Sin cerrar</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-slate-400">
              Ningún estudiante pendiente coincide con la búsqueda.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function StageAnalysisView({
  data,
  selectedWindow,
}: {
  data: TeacherDashboard;
  selectedWindow: AdvanceWindow | null;
}) {
  const total = data.summary.totalStudents;
  const [stage, setStage] = useState<PlanStageNumber>(() => defaultAnalysisStage(data.stageTotals, total));
  const completed = data.stageTotals[`e${stage}`] ?? 0;
  const percent = stagePercent(completed, total);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-xs text-slate-400">Etapa</p>
        <div role="radiogroup" aria-label="Etapa" className="flex flex-wrap gap-1.5">
          {DASHBOARD_STAGES.map((item) => {
            const selected = item === stage;
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={selected}
                title={stageName(item)}
                onClick={() => setStage(item)}
                className={[
                  "rounded-lg border px-2.5 py-1 text-left transition-colors",
                  selected
                    ? "border-sky-500/50 bg-sky-500/10"
                    : "border-slate-800 bg-slate-950/40 hover:border-slate-700",
                ].join(" ")}
              >
                <span className={`block text-sm font-medium ${selected ? "text-slate-100" : "text-slate-300"}`}>
                  E{item}
                </span>
                <span className="block text-[10px] tabular-nums text-slate-500">
                  {data.stageTotals[`e${item}`] ?? 0}/{total}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
        <h3 className="text-sm font-semibold text-slate-100">
          E{stage} · {stageName(stage)}
        </h3>
        <p className="mt-0.5 text-[11px] text-slate-500">Estado actual de la cohorte en esta etapa.</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Stat label="Completaron" value={`${completed} de ${total}`} tone="done" />
          <Stat label="No completaron" value={String(Math.max(0, total - completed))} />
          <Stat label="Completado" value={formatPercent(percent)} />
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800/80" aria-hidden>
          <div className="h-full rounded-full bg-emerald-500/60" style={{ width: `${percent ?? 0}%` }} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ClosuresCard analytics={data.analytics} stage={stage} selectedWindow={selectedWindow} />
        <ScoreCard analytics={data.analytics} stage={stage} />
      </div>

      <PendingTable data={data} stage={stage} />
    </div>
  );
}
