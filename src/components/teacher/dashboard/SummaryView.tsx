"use client";

// Vista Resumen: ¿cómo está la cohorte? Las tarjetas y el avance E0-E10 son el ESTADO ACTUAL y
// no se filtran por periodo. Debajo, la distribución de horas por estudiante (sin registros es
// una categoría aparte, nunca 0 h) y la actividad mensual (agrupada en UTC).

import { useState } from "react";

import type { TeacherDashboard } from "@/lib/teacher/dashboard/aggregate";
import type { AdvanceWindow, DashboardAnalytics } from "@/lib/teacher/dashboard/analytics";
import {
  formatCount,
  formatMonth,
  hoursDistribution,
  niceMax,
  spanPositions,
} from "@/lib/teacher/dashboard/analyticsView";
import { formatHours } from "@/lib/teacher/dashboard/view";

import { ChartCard, ChartReadout, ChartTable, HBar, MonthColumns, TimePlot } from "./charts";
import { StageProgressList } from "./StageProgressList";

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

// Con menos registros que esto, la distribución se marca como poco representativa.
const FEW_HOURS_RECORDS = 5;

function HoursDistributionCard({ data }: { data: TeacherDashboard }) {
  const total = data.summary.totalStudents;
  const distribution = hoursDistribution(data.students);
  const max = Math.max(1, distribution.withoutRecords, ...distribution.bins.map((bin) => bin.count));
  const few = distribution.withRecords > 0 && distribution.withRecords < FEW_HOURS_RECORDS;

  return (
    <ChartCard
      title="Horas por estudiante"
      subtitle="Total de horas declaradas por cada estudiante (no verificadas)."
      note={
        <>
          {few ? (
            <span className="block text-amber-200/80">
              Pocos datos: solo {distribution.withRecords} de {total} estudiantes registraron horas; la
              distribución es poco representativa.
            </span>
          ) : null}
          Cada rango incluye su límite inferior y excluye el superior.
        </>
      }
    >
      {distribution.withRecords === 0 ? (
        <p className="text-sm text-slate-400">Ningún estudiante registró horas todavía.</p>
      ) : (
        <div className="space-y-3">
          {distribution.bins.map((bin) => (
            <HBar
              key={bin.label}
              label={bin.label}
              value={bin.count}
              max={max}
              display={`${bin.count} est.`}
            />
          ))}
        </div>
      )}

      <div className="mt-4 border-t border-slate-800 pt-3">
        <HBar
          label="Sin registros (categoría aparte, no es 0 h)"
          value={distribution.withoutRecords}
          max={max}
          display={`${distribution.withoutRecords} de ${total}`}
          tone="muted"
        />
      </div>

      <ChartTable
        caption="Estudiantes por rango de horas declaradas"
        head={["Rango", "Estudiantes"]}
        rows={[
          ...distribution.bins.map((bin) => [bin.label, String(bin.count)]),
          ["Sin registros", String(distribution.withoutRecords)],
        ]}
      />
    </ChartCard>
  );
}

function ActivityCard({
  analytics,
  selectedWindow,
}: {
  analytics: DashboardAnalytics;
  selectedWindow: AdvanceWindow | null;
}) {
  const [active, setActive] = useState<number | null>(null);
  const points = analytics.activityByPeriod.points;
  const months = points.map((point) => point.period);
  const values = points.map((point) => point.studentMessages);
  const yMax = niceMax(Math.max(0, ...values));
  const totalMessages = values.reduce((sum, value) => sum + value, 0);
  const band = selectedWindow ? spanPositions(months, selectedWindow.from, selectedWindow.to) : null;
  const current = active !== null ? points[active] : null;

  return (
    <ChartCard
      title="Actividad por mes"
      subtitle="Mensajes enviados por los estudiantes y estudiantes activos (con al menos un mensaje)."
      note="Actividad agrupada en UTC: cada mensaje cuenta en el mes de su hora UTC. No se muestran mensajes individuales."
    >
      {months.length === 0 ? (
        <p className="text-sm text-slate-400">Sin actividad registrada.</p>
      ) : (
        <>
          <ChartReadout>
            {current ? (
              <>
                <span className="font-semibold text-slate-100">{formatCount(current.studentMessages)}</span>{" "}
                mensajes · <span className="font-semibold text-slate-100">{current.activeStudents}</span>{" "}
                estudiantes activos
                <span className="block text-slate-500">{formatMonth(current.period)} (UTC)</span>
              </>
            ) : (
              <>
                <span className="font-semibold text-slate-100">{formatCount(totalMessages)}</span> mensajes en
                todo el periodo
                <span className="block text-slate-500">Pasa el cursor o enfoca un mes para ver el detalle.</span>
              </>
            )}
          </ChartReadout>
          <TimePlot
            months={months}
            yMax={yMax}
            formatY={formatCount}
            band={band}
            label="Mensajes de estudiantes por mes (UTC)"
            footer={
              <div className="mt-1 flex text-[10px] tabular-nums text-slate-400" aria-hidden>
                {points.map((point) => (
                  <span key={point.period} className="min-w-0 flex-1 text-center">
                    {point.activeStudents}
                  </span>
                ))}
              </div>
            }
          >
            <MonthColumns
              values={values}
              yMax={yMax}
              activeIndex={active}
              onActivate={setActive}
              describe={(index) =>
                `${formatMonth(points[index].period)} (UTC): ${points[index].studentMessages} mensajes, ${points[index].activeStudents} estudiantes activos`
              }
            />
          </TimePlot>
          <p className="mt-1 pl-12 text-[10px] text-slate-500">Fila inferior: estudiantes activos en el mes.</p>
          <ChartTable
            caption="Actividad por mes (UTC)"
            head={["Mes (UTC)", "Mensajes de estudiantes", "Estudiantes activos"]}
            rows={points.map((point) => [
              formatMonth(point.period),
              formatCount(point.studentMessages),
              String(point.activeStudents),
            ])}
          />
        </>
      )}
    </ChartCard>
  );
}

export function SummaryView({
  data,
  selectedWindow,
}: {
  data: TeacherDashboard;
  selectedWindow: AdvanceWindow | null;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Estado actual</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Estudiantes" value={String(data.summary.totalStudents)} />
          <SummaryCard label="Aprobados" value={String(data.summary.approved)} />
          <SummaryCard label="Pendientes" value={String(data.summary.pending)} />
          <SummaryCard
            label="Horas registradas"
            value={formatHours(data.summary.totalHours)}
            hint={
              data.summary.totalHours === null
                ? "Nadie registró horas todavía"
                : `${data.summary.studentsWithHours} de ${data.summary.totalStudents} estudiantes con registros`
            }
          />
        </div>
      </div>

      <StageProgressList stageTotals={data.stageTotals} totalStudents={data.summary.totalStudents} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <HoursDistributionCard data={data} />
        <ActivityCard analytics={data.analytics} selectedWindow={selectedWindow} />
      </div>
    </div>
  );
}
