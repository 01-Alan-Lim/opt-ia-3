// src/lib/teacher/dashboard/analyticsView.ts
//
// Funciones puras de presentación de analytics (GET /api/teacher/dashboard): etiquetas de
// periodo, opciones del filtro de avances, posiciones en el eje temporal, distribución de horas
// por estudiante y selecciones de la vista Etapas. Sin React ni fetch. No calcula fechas de
// cierre, notas ni cumplimiento: ordena, filtra y formatea lo que ya trae el contrato.

import type { PlanStageNumber } from "@/lib/plan/stageArtifacts";
import type { DashboardStageKey, DashboardStudent } from "./aggregate";
import type {
  ActivityPeriod,
  AdvanceEvent,
  AdvanceWindow,
  AdvanceWindowKey,
  AdvanceWindowsStatus,
  CompletionStage,
  CumulativePoint,
  DashboardAnalytics,
  StageCounts,
  StageScoreDistribution,
  ValidationsPeriod,
} from "./analytics";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

type DateParts = { year: number; month: number; day: number };

// "YYYY-MM-DD" o "YYYY-MM" (día 1).
function parseDate(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: match[3] ? Number(match[3]) : 1 };
  return parts.month >= 1 && parts.month <= 12 && parts.day >= 1 ? parts : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCount(value: number): string {
  return value.toLocaleString("es-BO");
}

// "2026-03" -> "mar 2026".
export function formatMonth(period: string): string {
  const parts = parseDate(period);
  return parts ? `${MONTHS[parts.month - 1]} ${parts.year}` : period;
}

// Etiqueta del eje: el mes, con el año en el primer mes y en cada enero.
export function formatMonthTick(period: string, index: number): string {
  const parts = parseDate(period);
  if (!parts) return period;
  return index === 0 || parts.month === 1 ? `${MONTHS[parts.month - 1]} ${parts.year}` : MONTHS[parts.month - 1];
}

// "2026-04-03" -> "3 abr 2026".
export function formatDay(date: string): string {
  const parts = parseDate(date);
  return parts ? `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}` : date;
}

// Rango inclusivo de días; null = abierto.
export function formatDateRange(from: string | null, to: string | null): string {
  if (from === null && to === null) return "Sin límite de fechas";
  if (from === null) return `Hasta ${formatDay(to as string)}`;
  if (to === null) return `Desde ${formatDay(from)}`;
  const start = parseDate(from);
  const end = parseDate(to);
  if (start && end && start.year === end.year) {
    return `${start.day} ${MONTHS[start.month - 1]} – ${formatDay(to)}`;
  }
  return `${formatDay(from)} – ${formatDay(to)}`;
}

// --- Filtro de periodo (ventanas de los avances) -------------------------------------------

export type PeriodFilter = "all" | AdvanceWindowKey;

export type PeriodOption = { value: PeriodFilter; label: string; detail: string; disabled: boolean };

export const WINDOW_KEYS: readonly AdvanceWindowKey[] = ["advance1", "advance2", "advance3", "afterAdvance3"];

const WINDOW_LABELS: Record<AdvanceWindowKey, string> = {
  advance1: "Avance 1",
  advance2: "Avance 2",
  advance3: "Avance 3",
  afterAdvance3: "Después del Avance 3",
};

export function findWindow(analytics: DashboardAnalytics, filter: PeriodFilter): AdvanceWindow | null {
  if (filter === "all") return null;
  return analytics.advanceWindows.windows.find((window) => window.key === filter) ?? null;
}

export function periodOptions(analytics: DashboardAnalytics): PeriodOption[] {
  const all: PeriodOption = {
    value: "all",
    label: "Periodo completo",
    detail: formatDateRange(analytics.range.from, analytics.range.to),
    disabled: false,
  };
  return [
    all,
    ...WINDOW_KEYS.map((key) => {
      const window = findWindow(analytics, key);
      return window
        ? { value: key, label: WINDOW_LABELS[key], detail: formatDateRange(window.from, window.to), disabled: false }
        : { value: key, label: WINDOW_LABELS[key], detail: "Sin fechas", disabled: true };
    }),
  ];
}

export function windowsNotice(status: AdvanceWindowsStatus): string | null {
  if (status === "missing_advance_dates") {
    return "La cohorte no tiene configuradas las tres fechas de avance: el filtro por avance no está disponible.";
  }
  if (status === "unordered_dates") {
    return "Las fechas de avance de la cohorte no están en orden: el filtro por avance no está disponible.";
  }
  return null;
}

// --- Eje temporal por meses ------------------------------------------------------------------
// Las series mensuales comparten el eje months (validationsByPeriod). Una posición es un número
// de meses desde el inicio del eje: el día D del mes i está en i + (D - 1) / díasDelMes.

export function datePosition(months: readonly string[], date: string): number | null {
  const parts = parseDate(date);
  if (!parts) return null;
  const index = months.indexOf(date.slice(0, 7));
  if (index < 0) return null;
  return index + (parts.day - 1) / daysInMonth(parts.year, parts.month);
}

// Fin del día (exclusivo): donde termina una semana o una ventana inclusiva.
export function dateEndPosition(months: readonly string[], date: string): number | null {
  const parts = parseDate(date);
  const start = datePosition(months, date);
  if (!parts || start === null) return null;
  return start + 1 / daysInMonth(parts.year, parts.month);
}

// Tramo de un rango inclusivo de días dentro del eje, recortado a sus bordes; null si no lo toca.
export function spanPositions(
  months: readonly string[],
  from: string | null,
  to: string | null
): { start: number; end: number } | null {
  if (!months.length) return null;
  const first = months[0];
  const last = months[months.length - 1];

  let start: number | null = 0;
  if (from !== null && from.slice(0, 7) >= first) {
    start = from.slice(0, 7) > last ? null : datePosition(months, from);
  }
  let end: number | null = months.length;
  if (to !== null && to.slice(0, 7) <= last) {
    end = to.slice(0, 7) < first ? null : dateEndPosition(months, to);
  }

  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

// Máximo "redondo" del eje vertical (1, 2, 4, 6, 8 o 10 × 10^k) cuya mitad es al menos 1, para
// marcar 0, mitad y máximo.
export function niceMax(value: number): number {
  if (!(value > 0)) return 2;
  let power = 10 ** Math.floor(Math.log10(value));
  for (;;) {
    for (const step of [1, 2, 4, 6, 8, 10]) {
      if (step * power >= value && (step * power) / 2 >= 1) return step * power;
    }
    power *= 10;
  }
}

// --- Validaciones y acumulado por mes ---------------------------------------------------------

export function analyticsMonths(analytics: DashboardAnalytics): string[] {
  return analytics.validationsByPeriod.map((point) => point.period);
}

export function stageCountKey(stage: CompletionStage): keyof StageCounts {
  return `e${stage}`;
}

export const COMPLETION_STAGE_LIST: readonly CompletionStage[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Etapas con al menos una validación, en orden.
export function stageBreakdown(byStage: StageCounts): Array<{ stage: CompletionStage; count: number }> {
  return COMPLETION_STAGE_LIST.flatMap((stage) => {
    const count = byStage[stageCountKey(stage)];
    return count > 0 ? [{ stage, count }] : [];
  });
}

export function stageClosuresByMonth(
  analytics: DashboardAnalytics,
  stage: CompletionStage
): Array<{ period: string; count: number }> {
  return analytics.validationsByPeriod.map((point) => ({
    period: point.period,
    count: point.byStage[stageCountKey(stage)],
  }));
}

export type MonthDetail = {
  validations: ValidationsPeriod | null;
  cumulative: CumulativePoint | null;
  activity: ActivityPeriod | null;
  // Semanas que empiezan en el mes; sin semanas, totalHours es null (no 0).
  hours: { totalHours: number | null; entries: number; weeks: number };
};

export function monthDetail(analytics: DashboardAnalytics, month: string): MonthDetail {
  const weeks = analytics.hoursByPeriod.filter((week) => week.periodStart.slice(0, 7) === month);
  return {
    validations: analytics.validationsByPeriod.find((point) => point.period === month) ?? null,
    cumulative: analytics.cumulativeStageProgress.points.find((point) => point.period === month) ?? null,
    activity: analytics.activityByPeriod.points.find((point) => point.period === month) ?? null,
    hours: {
      totalHours: weeks.length ? round2(weeks.reduce((sum, week) => sum + week.totalHours, 0)) : null,
      entries: weeks.reduce((sum, week) => sum + week.entries, 0),
      weeks: weeks.length,
    },
  };
}

// --- Horas por estudiante ----------------------------------------------------------------------

// Rangos [mín, máx) en horas declaradas; el último no tiene tope.
export const HOURS_BIN_EDGES: readonly number[] = [0, 10, 25, 50, 100];

export type HoursBin = { label: string; min: number; max: number | null; count: number };

export type HoursDistribution = { bins: HoursBin[]; withRecords: number; withoutRecords: number };

// Sin registros (total null) es una categoría aparte: nunca cae en el rango de 0 h.
export function hoursDistribution(students: readonly DashboardStudent[]): HoursDistribution {
  const bins: HoursBin[] = HOURS_BIN_EDGES.map((min, index) => {
    const max = index + 1 < HOURS_BIN_EDGES.length ? HOURS_BIN_EDGES[index + 1] : null;
    return { label: max === null ? `${min} h o más` : `${min}–${max} h`, min, max, count: 0 };
  });

  let withoutRecords = 0;
  for (const student of students) {
    const total = student.hours.total;
    if (total === null) {
      withoutRecords += 1;
      continue;
    }
    const bin = bins.find((item) => total >= item.min && (item.max === null || total < item.max));
    if (bin) bin.count += 1;
  }

  return { bins, withRecords: students.length - withoutRecords, withoutRecords };
}

// --- Vista Etapas ------------------------------------------------------------------------------

// Etapa con más estudiantes sin cerrarla (empate: la menor). Sin estudiantes, E1.
export function defaultAnalysisStage(
  stageTotals: Record<DashboardStageKey, number>,
  totalStudents: number
): PlanStageNumber {
  if (totalStudents <= 0) return 1;
  const stages: PlanStageNumber[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let best: PlanStageNumber = 0;
  for (const stage of stages) {
    const pending = totalStudents - (stageTotals[`e${stage}`] ?? 0);
    const bestPending = totalStudents - (stageTotals[`e${best}`] ?? 0);
    if (pending > bestPending) best = stage;
  }
  return best;
}

export function scoreDistributionFor(
  analytics: DashboardAnalytics,
  stage: PlanStageNumber
): StageScoreDistribution | null {
  if (stage === 0) return null;
  return analytics.scoreDistributions.find((item) => item.stage === stage) ?? null;
}

// Escala fija de las rúbricas; otras etiquetas, si llegan, van al final.
export const SCORE_SCALE: readonly string[] = ["Deficiente", "Regular", "Adecuado", "Bien"];

export function scoreLabelRows(distribution: StageScoreDistribution): Array<{ label: string; count: number }> {
  const extra = Object.keys(distribution.labels).filter((label) => !SCORE_SCALE.includes(label));
  return [...SCORE_SCALE, ...extra].map((label) => ({ label, count: distribution.labels[label] ?? 0 }));
}

// --- Referencias de los avances ----------------------------------------------------------------

export type TimeMarker = { position: number; label: string; title: string };

// Fecha de referencia de cada avance dentro del eje (no es cumplimiento). Fuera del eje, no se
// dibuja.
export function advanceMarkers(months: readonly string[], events: readonly AdvanceEvent[]): TimeMarker[] {
  return events.flatMap((event) => {
    const position = datePosition(months, event.date);
    return position === null
      ? []
      : [
          {
            position,
            label: `A${event.index}`,
            title: `Fecha de referencia — ${event.label} (${formatDay(event.date)})`,
          },
        ];
  });
}
