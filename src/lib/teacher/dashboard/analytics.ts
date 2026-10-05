// src/lib/teacher/dashboard/analytics.ts
//
// Capa analítica temporal del panel docente (campo analytics de GET /api/teacher/dashboard):
// series preagregadas de UNA cohorte a partir del snapshot de estudiantes (aggregate.ts) y de
// las filas ya leídas. Sin Supabase, fetch ni React.
//
// Fechas:
// - E0 no tiene fecha: plan_case_contexts no guarda cuándo se confirmó (created_at es el
//   borrador y updated_at se mueve con ediciones posteriores). No entra en ninguna serie.
// - E1: primera evaluación de su artefacto final (plan_stage_evaluations.created_at), que se
//   inserta en cada validación. No se usan period_key (es el mes de los datos declarados) ni el
//   created_at del artefacto (es el del borrador). Un E1 cerrado sin evaluación queda sin fecha
//   (cumulativeStageProgress.undated).
// - E2-E10: validatedAt del snapshot, el created_at más antiguo del artefacto final validado en
//   cualquier periodo: la fila nace validada y el upsert conserva created_at (updated_at no).
// - Primera finalización por estudiante y etapa: revalidaciones y otros periodos no suman.
// - Meses y días en America/La_Paz. Excepción: v_bi_usage_daily agrupa por día UTC, y la
//   actividad lo declara (timezone "UTC"). PERIOD_KEY no se usa como eje.
// - Horas: semanas con registros (period_start/period_end de hours_entries). Una semana sin
//   registros no aparece: sin registro no es 0 h; un registro de 0 h sí cuenta.
// - Notas: una por estudiante y etapa, la vigente del snapshot (la misma de la matriz), que sale
//   solo de plan_stage_evaluations. Estadísticas separadas por etapa: no hay nota general.
//
// Ventanas de los avances (periodos de REFERENCIA, no de cumplimiento), en días de La Paz e
// inclusivas: hasta el Avance 1; día siguiente al Avance 1 → Avance 2; día siguiente al
// Avance 2 → Avance 3; día siguiente al Avance 3 en adelante. La fecha de un avance pertenece a
// su propia ventana. Cubren toda la línea de tiempo (la primera sin inicio y la última sin fin)
// para que ningún dato quede fuera: hay registros anteriores al inicio de acceso. El inicio y el
// fin académicos están en range. Solo se arman si existen los tres avances en orden. Dentro de
// una ventana, una semana de horas cuenta por su period_start y un día de actividad por su
// fecha UTC.

import {
  ADVANCE_INDEXES,
  ADVANCE_REFERENCE_STAGES,
  advanceLabel,
  isAdvanceIndex,
  type AdvanceIndex,
  type AdvanceStageRange,
} from "@/lib/plan/advanceStages";
import { FINAL_ARTIFACT_BY_STAGE, type PlanStageNumber } from "@/lib/plan/stageArtifacts";
import { getDateKeyLaPaz } from "@/lib/time/periodKey";
import type { DashboardStudent } from "./aggregate";
import type {
  DashboardAdvanceEventRow,
  DashboardEvaluationRow,
  DashboardHoursRow,
  DashboardUsageDailyRow,
} from "./rows";
import { normalizeUserId, round2, timeOf, toFiniteNumber } from "./values";

export const ANALYTICS_TIMEZONE = "America/La_Paz";
export const ACTIVITY_TIMEZONE = "UTC";

export type CompletionStage = Exclude<PlanStageNumber, 0>;
export type CompletionStageKey = `e${CompletionStage}`;
export type StageCounts = Record<CompletionStageKey, number>;

export const COMPLETION_STAGES: readonly CompletionStage[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// from/to: días YYYY-MM-DD en La Paz. Salen del acceso de la cohorte; si falta, de la extensión
// de los datos; sin ninguno, null.
export type AnalyticsRange = {
  from: string | null;
  to: string | null;
  timezone: typeof ANALYTICS_TIMEZONE;
};

export type AdvanceEvent = {
  index: AdvanceIndex;
  date: string;
  label: string;
  referenceStageRange: AdvanceStageRange;
};

export type AdvanceWindowKey = "advance1" | "advance2" | "advance3" | "afterAdvance3";

export type AdvanceWindowBounds = {
  key: AdvanceWindowKey;
  advanceIndex: AdvanceIndex | null;
  label: string;
  // Inclusivos; null = abierto (solo el inicio de la primera y el fin de la última).
  from: string | null;
  to: string | null;
  referenceStageRange: AdvanceStageRange | null;
};

export type WindowSummary = {
  validations: { total: number; byStage: StageCounts };
  hours: { totalHours: number | null; entries: number; studentsWithRecords: number };
  activity: { timezone: typeof ACTIVITY_TIMEZONE; studentMessages: number; activeStudents: number };
};

export type AdvanceWindow = AdvanceWindowBounds & { summary: WindowSummary };

export type AdvanceWindowsStatus = "available" | "missing_advance_dates" | "unordered_dates";

export type ValidationsPeriod = { period: string; total: number; byStage: StageCounts };

export type CumulativePoint = { period: string; stages: StageCounts };

export type HoursPeriod = {
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  entries: number;
  studentsWithRecords: number;
  cumulativeHours: number;
};

export type ActivityPeriod = { period: string; studentMessages: number; activeStudents: number };

export type StageScoreDistribution = {
  stage: CompletionStage;
  count: number;
  min: number | null;
  max: number | null;
  average: number | null;
  labels: Record<string, number>;
};

export type DashboardAnalytics = {
  range: AnalyticsRange;
  advanceEvents: AdvanceEvent[];
  advanceWindows: { status: AdvanceWindowsStatus; windows: AdvanceWindow[] };
  // Meses YYYY-MM (La Paz), continuos y sin huecos: un mes sin cierres vale 0.
  validationsByPeriod: ValidationsPeriod[];
  // Mismo eje mensual. undated: cierres del snapshot sin fecha usable (hoy solo E1 sin
  // evaluación); último punto + undated = stageTotals de E1-E10.
  cumulativeStageProgress: { points: CumulativePoint[]; undated: StageCounts };
  // Semanas con al menos un registro, en orden.
  hoursByPeriod: HoursPeriod[];
  // Meses YYYY-MM en UTC sobre el mismo eje: un mes sin mensajes vale 0.
  activityByPeriod: { timezone: typeof ACTIVITY_TIMEZONE; points: ActivityPeriod[] };
  // E1-E10 siempre; una etapa sin evaluaciones tiene count 0 y min/max/average null.
  scoreDistributions: StageScoreDistribution[];
};

export type DashboardAnalyticsInput = {
  cohort: { accessStartsAt: string | null; accessEndsAt: string | null };
  now: Date;
  students: readonly DashboardStudent[];
  // Filas de los estudiantes de la cohorte (user_id normalizado).
  evaluations: ReadonlyMap<string, readonly DashboardEvaluationRow[]>;
  hours: readonly DashboardHoursRow[];
  usageDaily: readonly DashboardUsageDailyRow[];
  advanceEvents: readonly DashboardAdvanceEventRow[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCORE_LABEL_ORDER = ["Deficiente", "Regular", "Adecuado", "Bien"];

type Completion = { stage: CompletionStage; date: string };

function stageKey(stage: CompletionStage): CompletionStageKey {
  return `e${stage}`;
}

function emptyStageCounts(): StageCounts {
  return Object.fromEntries(COMPLETION_STAGES.map((stage) => [stageKey(stage), 0])) as StageCounts;
}

// Día calendario en La Paz de un timestamp; null si no se puede leer.
function laPazDate(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? getDateKeyLaPaz(new Date(ms)) : null;
}

// Día siguiente a una fecha YYYY-MM-DD.
export function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

// Meses YYYY-MM desde from hasta to, inclusive.
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  while (year < toYear || (year === toYear && month <= toMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function inRange(date: string, from: string | null, to: string | null): boolean {
  return (from === null || date >= from) && (to === null || date <= to);
}

function earliest(values: readonly string[]): string | null {
  return values.reduce<string | null>((min, value) => (min === null || value < min ? value : min), null);
}

function latest(values: readonly string[]): string | null {
  return values.reduce<string | null>((max, value) => (max === null || value > max ? value : max), null);
}

// Primera evaluación del artefacto final de E1 del estudiante (timestamp original).
function firstE1EvaluationAt(rows: readonly DashboardEvaluationRow[]): string | null {
  const finalArtifact = FINAL_ARTIFACT_BY_STAGE.get(1);
  let first: string | null = null;
  for (const row of rows) {
    if (row.stage !== 1 || row.artifact_type !== finalArtifact) continue;
    if (!Number.isFinite(Date.parse(row.created_at))) continue;
    if (first === null || timeOf(row.created_at) < timeOf(first)) first = row.created_at;
  }
  return first;
}

// Primera finalización de cada estudiante y etapa E1-E10 cerrada en el snapshot.
function collectCompletions(
  students: readonly DashboardStudent[],
  evaluations: ReadonlyMap<string, readonly DashboardEvaluationRow[]>
): { completions: Completion[]; undated: StageCounts } {
  const completions: Completion[] = [];
  const undated = emptyStageCounts();

  for (const student of students) {
    const userId = normalizeUserId(student.userId);
    for (const stage of COMPLETION_STAGES) {
      const progress = student.progress.find((item) => item.stage === stage);
      if (!progress?.completed) continue;

      const at =
        stage === 1 ? firstE1EvaluationAt(evaluations.get(userId) ?? []) : progress.validatedAt;
      const date = at === null ? null : laPazDate(at);

      if (date === null) undated[stageKey(stage)] += 1;
      else completions.push({ stage, date });
    }
  }

  return { completions, undated };
}

export function buildAdvanceEvents(rows: readonly DashboardAdvanceEventRow[]): AdvanceEvent[] {
  const dateByIndex = new Map<AdvanceIndex, string>();
  for (const row of rows) {
    if (row.event_kind !== "ADVANCE" || !row.is_enabled) continue;
    if (!isAdvanceIndex(row.event_index)) continue;
    const date = row.event_date.slice(0, 10);
    if (!DATE_RE.test(date) || dateByIndex.has(row.event_index)) continue;
    dateByIndex.set(row.event_index, date);
  }

  return ADVANCE_INDEXES.flatMap((index) => {
    const date = dateByIndex.get(index);
    return date
      ? [{ index, date, label: advanceLabel(index), referenceStageRange: { ...ADVANCE_REFERENCE_STAGES[index] } }]
      : [];
  });
}

export function buildAdvanceWindowBounds(events: readonly AdvanceEvent[]): {
  status: AdvanceWindowsStatus;
  bounds: AdvanceWindowBounds[];
} {
  const [a1, a2, a3] = ADVANCE_INDEXES.map(
    (index) => events.find((event) => event.index === index)?.date ?? null
  );
  if (a1 === null || a2 === null || a3 === null) {
    return { status: "missing_advance_dates", bounds: [] };
  }
  if (!(a1 < a2 && a2 < a3)) return { status: "unordered_dates", bounds: [] };

  const makeWindow = (
    key: AdvanceWindowKey,
    advanceIndex: AdvanceIndex | null,
    from: string | null,
    to: string | null
  ): AdvanceWindowBounds => ({
    key,
    advanceIndex,
    label: advanceIndex === null ? "Después del Avance 3" : advanceLabel(advanceIndex),
    from,
    to,
    referenceStageRange: advanceIndex === null ? null : { ...ADVANCE_REFERENCE_STAGES[advanceIndex] },
  });

  return {
    status: "available",
    bounds: [
      makeWindow("advance1", 1, null, a1),
      makeWindow("advance2", 2, nextDate(a1), a2),
      makeWindow("advance3", 3, nextDate(a2), a3),
      makeWindow("afterAdvance3", null, nextDate(a3), null),
    ],
  };
}

function summarizeWindow(
  from: string | null,
  to: string | null,
  data: {
    completions: readonly Completion[];
    hours: readonly DashboardHoursRow[];
    usage: readonly DashboardUsageDailyRow[];
  }
): WindowSummary {
  const byStage = emptyStageCounts();
  let validations = 0;
  for (const completion of data.completions) {
    if (!inRange(completion.date, from, to)) continue;
    byStage[stageKey(completion.stage)] += 1;
    validations += 1;
  }

  let hoursTotal = 0;
  let entries = 0;
  const withRecords = new Set<string>();
  for (const row of data.hours) {
    if (!inRange(row.period_start, from, to)) continue;
    hoursTotal += toFiniteNumber(row.hours) ?? 0;
    entries += 1;
    withRecords.add(normalizeUserId(row.user_id));
  }

  let studentMessages = 0;
  const active = new Set<string>();
  for (const row of data.usage) {
    if (row.user_id === null || !inRange(row.day, from, to)) continue;
    const messages = toFiniteNumber(row.messages_user) ?? 0;
    studentMessages += messages;
    if (messages > 0) active.add(normalizeUserId(row.user_id));
  }

  return {
    validations: { total: validations, byStage },
    hours: {
      totalHours: entries ? round2(hoursTotal) : null,
      entries,
      studentsWithRecords: withRecords.size,
    },
    activity: { timezone: ACTIVITY_TIMEZONE, studentMessages, activeStudents: active.size },
  };
}

function buildHoursByPeriod(hours: readonly DashboardHoursRow[]): HoursPeriod[] {
  const weeks = new Map<string, { periodStart: string; periodEnd: string; total: number; entries: number; users: Set<string> }>();
  for (const row of hours) {
    const key = `${row.period_start}|${row.period_end}`;
    let week = weeks.get(key);
    if (!week) {
      week = { periodStart: row.period_start, periodEnd: row.period_end, total: 0, entries: 0, users: new Set() };
      weeks.set(key, week);
    }
    week.total += toFiniteNumber(row.hours) ?? 0;
    week.entries += 1;
    week.users.add(normalizeUserId(row.user_id));
  }

  const sorted = [...weeks.values()].sort(
    (a, b) => a.periodStart.localeCompare(b.periodStart) || a.periodEnd.localeCompare(b.periodEnd)
  );

  let cumulative = 0;
  return sorted.map((week) => {
    cumulative += week.total;
    return {
      periodStart: week.periodStart,
      periodEnd: week.periodEnd,
      totalHours: round2(week.total),
      entries: week.entries,
      studentsWithRecords: week.users.size,
      cumulativeHours: round2(cumulative),
    };
  });
}

function buildActivityByPeriod(
  usage: readonly DashboardUsageDailyRow[],
  months: readonly string[]
): ActivityPeriod[] {
  const messagesByMonth = new Map<string, number>();
  const activeByMonth = new Map<string, Set<string>>();
  for (const row of usage) {
    if (row.user_id === null) continue;
    const month = row.day.slice(0, 7);
    const messages = toFiniteNumber(row.messages_user) ?? 0;
    messagesByMonth.set(month, (messagesByMonth.get(month) ?? 0) + messages);
    if (messages > 0) {
      const active = activeByMonth.get(month) ?? new Set<string>();
      active.add(normalizeUserId(row.user_id));
      activeByMonth.set(month, active);
    }
  }

  return months.map((period) => ({
    period,
    studentMessages: messagesByMonth.get(period) ?? 0,
    activeStudents: activeByMonth.get(period)?.size ?? 0,
  }));
}

function orderLabels(counts: ReadonlyMap<string, number>): Record<string, number> {
  const known = SCORE_LABEL_ORDER.filter((label) => counts.has(label));
  const others = [...counts.keys()]
    .filter((label) => !SCORE_LABEL_ORDER.includes(label))
    .sort((a, b) => a.localeCompare(b, "es"));
  return Object.fromEntries([...known, ...others].map((label) => [label, counts.get(label) ?? 0]));
}

function buildScoreDistributions(students: readonly DashboardStudent[]): StageScoreDistribution[] {
  return COMPLETION_STAGES.map((stage) => {
    const scores: number[] = [];
    const labels = new Map<string, number>();
    for (const student of students) {
      const progress = student.progress.find((item) => item.stage === stage);
      if (!progress || progress.score === null) continue;
      scores.push(progress.score);
      if (progress.scoreLabel !== null) {
        labels.set(progress.scoreLabel, (labels.get(progress.scoreLabel) ?? 0) + 1);
      }
    }

    if (!scores.length) {
      return { stage, count: 0, min: null, max: null, average: null, labels: {} };
    }
    return {
      stage,
      count: scores.length,
      min: Math.min(...scores),
      max: Math.max(...scores),
      average: round2(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      labels: orderLabels(labels),
    };
  });
}

export function buildDashboardAnalytics(input: DashboardAnalyticsInput): DashboardAnalytics {
  const { completions, undated } = collectCompletions(input.students, input.evaluations);
  const hours = input.hours.filter(
    (row) => DATE_RE.test(row.period_start) && DATE_RE.test(row.period_end)
  );
  const usage = input.usageDaily.filter((row) => row.user_id !== null && DATE_RE.test(row.day));

  const cohortStart = input.cohort.accessStartsAt ? laPazDate(input.cohort.accessStartsAt) : null;
  const cohortEnd = input.cohort.accessEndsAt ? laPazDate(input.cohort.accessEndsAt) : null;

  const dataDates = [
    ...completions.map((completion) => completion.date),
    ...hours.map((row) => row.period_start),
    ...usage.map((row) => row.day),
  ];
  const range: AnalyticsRange = {
    from: cohortStart ?? earliest(dataDates),
    to: cohortEnd ?? latest(dataDates),
    timezone: ANALYTICS_TIMEZONE,
  };

  // Eje mensual: desde el inicio del rango (o el primer dato) hasta el fin del rango sin pasar
  // del mes actual, ampliado si hay datos fuera.
  const dataMonths = dataDates.map((date) => date.slice(0, 7));
  const startCandidates = range.from ? [...dataMonths, range.from.slice(0, 7)] : dataMonths;
  const start = earliest(startCandidates);
  const nowMonth = getDateKeyLaPaz(input.now).slice(0, 7);
  const rangeEnd = range.to ? range.to.slice(0, 7) : nowMonth;
  const lastData = latest(dataMonths);
  let end = rangeEnd < nowMonth ? rangeEnd : nowMonth;
  if (lastData !== null && lastData > end) end = lastData;
  const months = start !== null && start <= end ? monthsBetween(start, end) : [];

  const validationsByPeriod: ValidationsPeriod[] = months.map((period) => {
    const byStage = emptyStageCounts();
    let total = 0;
    for (const completion of completions) {
      if (completion.date.slice(0, 7) !== period) continue;
      byStage[stageKey(completion.stage)] += 1;
      total += 1;
    }
    return { period, total, byStage };
  });

  const running = emptyStageCounts();
  const cumulativePoints: CumulativePoint[] = validationsByPeriod.map((point) => {
    for (const stage of COMPLETION_STAGES) running[stageKey(stage)] += point.byStage[stageKey(stage)];
    return { period: point.period, stages: { ...running } };
  });

  const advanceEvents = buildAdvanceEvents(input.advanceEvents);
  const windowBounds = buildAdvanceWindowBounds(advanceEvents);

  return {
    range,
    advanceEvents,
    advanceWindows: {
      status: windowBounds.status,
      windows: windowBounds.bounds.map((bounds) => ({
        ...bounds,
        summary: summarizeWindow(bounds.from, bounds.to, { completions, hours, usage }),
      })),
    },
    validationsByPeriod,
    cumulativeStageProgress: { points: cumulativePoints, undated },
    hoursByPeriod: buildHoursByPeriod(hours),
    activityByPeriod: { timezone: ACTIVITY_TIMEZONE, points: buildActivityByPeriod(usage, months) },
    scoreDistributions: buildScoreDistributions(input.students),
  };
}
