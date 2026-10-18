"use client";

// Vista Evolución: ¿cómo evolucionó la cohorte en el tiempo? Primeras validaciones acumuladas
// de E1-E10 (una serie independiente por etapa, en paneles con la misma escala), etapas
// validadas por mes y horas declaradas por semana. Las líneas A1-A3 son las fechas de
// referencia de los avances (analytics.advanceEvents), no cumplimiento. El filtro de mes resalta
// lo ocurrido en ese mes; no reconstruye el estado de la cohorte en él.

import { useState } from "react";

import type { TeacherDashboard } from "@/lib/teacher/dashboard/aggregate";
import type { AdvanceWindow, CompletionStage, DashboardAnalytics } from "@/lib/teacher/dashboard/analytics";
import {
  advanceMarkers,
  analyticsMonths,
  COMPLETION_STAGE_LIST,
  formatCount,
  formatDateRange,
  formatMonth,
  formatMonthTick,
  monthDetail,
  niceMax,
  spanPositions,
  stageBreakdown,
  stageCountKey,
  type TimeMarker,
} from "@/lib/teacher/dashboard/analyticsView";
import { formatHours, stageName } from "@/lib/teacher/dashboard/view";

import {
  BreakdownText,
  ChartCard,
  ChartReadout,
  ChartTable,
  MiniLine,
  MonthColumns,
  SpanBars,
  TimePlot,
  type Span,
} from "./charts";

// Etapas visibles al entrar: un muestreo del plan, todas activables.
const DEFAULT_VISIBLE_STAGES: readonly CompletionStage[] = [1, 3, 5, 8, 10];

function MonthDetailPanel({ analytics, month }: { analytics: DashboardAnalytics; month: string }) {
  const detail = monthDetail(analytics, month);
  const label = formatMonth(month);

  return (
    <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
      <h3 className="text-sm font-semibold text-slate-100">{label}</h3>
      <dl className="mt-3 grid grid-cols-1 gap-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-[11px] text-slate-500">Validaciones realizadas en {label}</dt>
          <dd className="mt-0.5">
            <span className="text-lg font-semibold text-slate-100">{detail.validations?.total ?? 0}</span>{" "}
            <span className="text-slate-400">etapas</span>
            {detail.validations ? (
              <span className="block text-xs">
                <BreakdownText byStage={detail.validations.byStage} />
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Horas registradas en semanas que inician en {label}</dt>
          <dd className="mt-0.5">
            <span className="text-lg font-semibold text-slate-100">{formatHours(detail.hours.totalHours)}</span>
            {detail.hours.entries > 0 ? (
              <span className="block text-xs text-slate-400">
                {detail.hours.entries} registros en {detail.hours.weeks} semanas
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Actividad durante {label} (UTC)</dt>
          <dd className="mt-0.5">
            <span className="text-lg font-semibold text-slate-100">
              {formatCount(detail.activity?.studentMessages ?? 0)}
            </span>{" "}
            <span className="text-slate-400">mensajes</span>
            <span className="block text-xs text-slate-400">
              {detail.activity?.activeStudents ?? 0} estudiantes activos
            </span>
          </dd>
        </div>
      </dl>
      {detail.cumulative ? (
        <p className="mt-3 border-t border-slate-800 pt-2 text-xs">
          <span className="text-slate-500">Primeras validaciones acumuladas al cierre de {label}: </span>
          <BreakdownText byStage={detail.cumulative.stages} />
        </p>
      ) : null}
    </section>
  );
}

function CumulativeCard({
  analytics,
  totalStudents,
  months,
  markers,
  band,
  highlight,
}: {
  analytics: DashboardAnalytics;
  totalStudents: number;
  months: readonly string[];
  markers: TimeMarker[];
  band: Span | null;
  highlight: number | null;
}) {
  const [visible, setVisible] = useState<readonly CompletionStage[]>(DEFAULT_VISIBLE_STAGES);
  const points = analytics.cumulativeStageProgress.points;
  const undated = analytics.cumulativeStageProgress.undated;
  const yMax = Math.max(1, totalStudents);
  const shown = COMPLETION_STAGE_LIST.filter((stage) => visible.includes(stage));

  function toggle(stage: CompletionStage) {
    setVisible((current) =>
      current.includes(stage) ? current.filter((item) => item !== stage) : [...current, stage]
    );
  }

  return (
    <ChartCard
      title="Progreso acumulado E1–E10"
      subtitle={`Estudiantes con la primera validación de cada etapa, al cierre de cada mes. Misma escala en todos los paneles: 0 a ${totalStudents} estudiantes.`}
      note="Cada etapa es una serie independiente (no es un embudo). El último punto coincide con el estado actual. E0 no aparece: no tiene fecha histórica de confirmación."
    >
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Etapas visibles">
        {COMPLETION_STAGE_LIST.map((stage) => {
          const on = visible.includes(stage);
          return (
            <button
              key={stage}
              type="button"
              aria-pressed={on}
              title={stageName(stage)}
              onClick={() => toggle(stage)}
              className={[
                "rounded-md border px-2 py-1 text-xs tabular-nums transition-colors",
                on
                  ? "border-sky-500/40 bg-sky-500/15 text-slate-100"
                  : "border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300",
              ].join(" ")}
            >
              E{stage}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-slate-800" aria-hidden />
        <button
          type="button"
          onClick={() => setVisible(COMPLETION_STAGE_LIST)}
          className="rounded-md px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
        >
          Todas
        </button>
        <button
          type="button"
          onClick={() => setVisible(DEFAULT_VISIBLE_STAGES)}
          className="rounded-md px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
        >
          Restablecer
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">Selecciona al menos una etapa.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {shown.map((stage) => {
            const key = stageCountKey(stage);
            const values = points.map((point) => point.stages[key]);
            const last = values[values.length - 1] ?? 0;
            const atMonth = highlight !== null ? values[highlight] : null;
            return (
              <div key={stage} className="rounded-xl border border-slate-800/80 bg-slate-950/30 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-xs">
                    <span className="font-semibold text-slate-100">E{stage}</span>{" "}
                    <span className="text-slate-400">{stageName(stage)}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-200">
                    {last}/{totalStudents}
                  </span>
                </div>
                <div className="mt-2">
                  <MiniLine
                    values={values}
                    yMax={yMax}
                    markers={markers}
                    band={band}
                    highlight={highlight}
                    label={`E${stage} ${stageName(stage)}: ${last} de ${totalStudents} estudiantes al último mes`}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-slate-500" aria-hidden>
                  <span>{months.length ? formatMonthTick(months[0], 0) : ""}</span>
                  <span>{months.length ? formatMonth(months[months.length - 1]) : ""}</span>
                </div>
                {atMonth !== null && atMonth !== undefined ? (
                  <p className="mt-1 text-[11px] text-slate-300">
                    Al cierre de {formatMonth(months[highlight as number])}:{" "}
                    <span className="font-semibold tabular-nums text-slate-100">{atMonth}</span>
                  </p>
                ) : null}
                {undated[key] > 0 ? (
                  <p className="mt-1 text-[11px] text-amber-200/80">
                    {undated[key]} cierres sin fecha no aparecen en la serie.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ChartTable
        caption="Primeras validaciones acumuladas por etapa y mes"
        head={["Mes", ...shown.map((stage) => `E${stage}`)]}
        rows={points.map((point) => [
          formatMonth(point.period),
          ...shown.map((stage) => String(point.stages[stageCountKey(stage)])),
        ])}
      />
    </ChartCard>
  );
}

function ValidationsCard({
  analytics,
  months,
  markers,
  band,
  highlight,
  onSelectMonth,
}: {
  analytics: DashboardAnalytics;
  months: readonly string[];
  markers: TimeMarker[];
  band: Span | null;
  highlight: number | null;
  onSelectMonth: (month: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const points = analytics.validationsByPeriod;
  const values = points.map((point) => point.total);
  const yMax = niceMax(Math.max(0, ...values));
  const activeIndex = hover ?? highlight;
  const current = activeIndex !== null ? points[activeIndex] : null;

  return (
    <ChartCard
      title="Etapas validadas por mes"
      subtitle="Primeras validaciones de E1–E10 realizadas en cada mes. Cuenta etapas, no estudiantes."
      note="Haz clic en un mes para fijarlo como filtro de la vista."
    >
      <ChartReadout>
        {current ? (
          <>
            <span className="font-semibold text-slate-100">{current.total}</span> etapas validadas en{" "}
            {formatMonth(current.period)}
            <span className="block text-xs">
              <BreakdownText byStage={current.byStage} />
            </span>
          </>
        ) : (
          <span className="text-slate-500">Pasa el cursor sobre un mes para ver el desglose por etapa.</span>
        )}
      </ChartReadout>
      <TimePlot
        months={months}
        yMax={yMax}
        markers={markers}
        band={band}
        highlight={highlight}
        label="Etapas validadas por mes"
      >
        <MonthColumns
          values={values}
          yMax={yMax}
          activeIndex={activeIndex}
          onActivate={setHover}
          onSelect={(index) => onSelectMonth(points[index].period)}
          describe={(index) => `${formatMonth(points[index].period)}: ${points[index].total} etapas validadas`}
        />
      </TimePlot>
      <ChartTable
        caption="Etapas validadas por mes"
        head={["Mes", "Etapas validadas", "Desglose"]}
        rows={points.map((point) => [
          formatMonth(point.period),
          String(point.total),
          stageBreakdown(point.byStage)
            .map((item) => `E${item.stage}: ${item.count}`)
            .join(", ") || "—",
        ])}
      />
    </ChartCard>
  );
}

function HoursWeeklyCard({
  analytics,
  months,
  markers,
  band,
  highlight,
}: {
  analytics: DashboardAnalytics;
  months: readonly string[];
  markers: TimeMarker[];
  band: Span | null;
  highlight: number | null;
}) {
  const [active, setActive] = useState<number | null>(null);
  const weeks = analytics.hoursByPeriod.flatMap((week) => {
    const span = spanPositions(months, week.periodStart, week.periodEnd);
    return span ? [{ week, span }] : [];
  });
  const yMax = niceMax(Math.max(0, ...weeks.map((item) => item.week.totalHours)));
  const current = active !== null ? weeks[active]?.week ?? null : null;
  const last = analytics.hoursByPeriod[analytics.hoursByPeriod.length - 1];

  return (
    <ChartCard
      title="Horas declaradas por semana"
      subtitle="Suma de las horas registradas por los estudiantes en cada semana (sábado a viernes)."
      note="Las semanas sin registros no se dibujan: no equivalen a 0 h. Son horas declaradas, no verificadas."
    >
      {weeks.length === 0 ? (
        <p className="text-sm text-slate-400">Nadie registró horas todavía.</p>
      ) : (
        <>
          <ChartReadout>
            {current ? (
              <>
                <span className="font-semibold text-slate-100">{formatHours(current.totalHours)}</span> declaradas
                · {current.entries} registros de {current.studentsWithRecords} estudiantes
                <span className="block text-slate-500">
                  Semana {formatDateRange(current.periodStart, current.periodEnd)} · acumulado{" "}
                  {formatHours(current.cumulativeHours)}
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold text-slate-100">{formatHours(last?.cumulativeHours ?? null)}</span>{" "}
                declaradas en {analytics.hoursByPeriod.length} semanas con registros
                <span className="block text-slate-500">Pasa el cursor o enfoca una semana para ver el detalle.</span>
              </>
            )}
          </ChartReadout>
          <TimePlot
            months={months}
            yMax={yMax}
            formatY={(value) => `${formatCount(value)} h`}
            markers={markers}
            band={band}
            highlight={highlight}
            label="Horas declaradas por semana"
          >
            <SpanBars
              items={weeks.map((item) => ({ ...item.span, value: item.week.totalHours }))}
              months={months}
              yMax={yMax}
              activeIndex={active}
              onActivate={setActive}
              describe={(index) =>
                `Semana ${formatDateRange(weeks[index].week.periodStart, weeks[index].week.periodEnd)}: ${formatHours(weeks[index].week.totalHours)}`
              }
            />
          </TimePlot>
          <ChartTable
            caption="Horas declaradas por semana"
            head={["Semana", "Horas", "Registros", "Estudiantes", "Acumulado"]}
            rows={analytics.hoursByPeriod.map((week) => [
              formatDateRange(week.periodStart, week.periodEnd),
              formatHours(week.totalHours),
              String(week.entries),
              String(week.studentsWithRecords),
              formatHours(week.cumulativeHours),
            ])}
          />
        </>
      )}
    </ChartCard>
  );
}

export function EvolutionView({
  data,
  selectedWindow,
}: {
  data: TeacherDashboard;
  selectedWindow: AdvanceWindow | null;
}) {
  const analytics = data.analytics;
  const months = analyticsMonths(analytics);
  const [monthChoice, setMonthChoice] = useState<string>("all");
  const month = months.includes(monthChoice) ? monthChoice : null;
  const highlight = month !== null ? months.indexOf(month) : null;
  const markers = advanceMarkers(months, analytics.advanceEvents);
  const band = selectedWindow ? spanPositions(months, selectedWindow.from, selectedWindow.to) : null;

  if (!months.length) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-sm text-slate-300">
        Todavía no hay datos temporales para esta cohorte.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block w-full sm:w-56">
          <span className="mb-1 block text-xs text-slate-400">Mes</span>
          <select
            value={month ?? "all"}
            onChange={(e) => setMonthChoice(e.target.value)}
            className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
          >
            <option value="all">Todos los meses</option>
            {months.map((item) => (
              <option key={item} value={item}>
                {formatMonth(item)}
              </option>
            ))}
          </select>
        </label>
        <p className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="inline-block h-3 w-px bg-slate-400/60" aria-hidden />
          A1, A2, A3: fechas de referencia de los avances (no indican cumplimiento).
        </p>
      </div>

      {month !== null && <MonthDetailPanel analytics={analytics} month={month} />}

      <CumulativeCard
        analytics={analytics}
        totalStudents={data.summary.totalStudents}
        months={months}
        markers={markers}
        band={band}
        highlight={highlight}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ValidationsCard
          analytics={analytics}
          months={months}
          markers={markers}
          band={band}
          highlight={highlight}
          onSelectMonth={(selected) => setMonthChoice((current) => (current === selected ? "all" : selected))}
        />
        <HoursWeeklyCard
          analytics={analytics}
          months={months}
          markers={markers}
          band={band}
          highlight={highlight}
        />
      </div>
    </div>
  );
}
