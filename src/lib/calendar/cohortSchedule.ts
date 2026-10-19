// src/lib/calendar/cohortSchedule.ts
//
// Calendario académico de una cohorte (puro, sin red; lo usan el panel docente y las
// invitaciones). Cada cohorte tiene ocho eventos en cohort_events: formulario inicial, tres
// seguimientos (FORM_MONTHLY 1-3), formulario de sistematización (FORM_FINAL) y tres avances.
//
// Seguimientos: el docente elige la fecha del Seguimiento 1. Se toma su día de la semana y su
// posición en el mes (1.º a 4.º, o el último si no hay otro igual después en ese mes) y se repite
// en los dos meses siguientes: primer sábado de octubre de 2026 -> 03/10, 07/11 y 05/12; último
// sábado -> último sábado. Todo mes tiene al menos cuatro veces cada día de la semana, así que la
// fecha existe siempre. Las fechas son YYYY-MM-DD de calendario y se calculan con Date.UTC y getUTCDay, nunca
// con la hora local: el resultado no depende de la zona horaria del navegador ni del servidor.

export const FOLLOWUP_COUNT = 3;

export type MonthlyPosition = 1 | 2 | 3 | 4 | "last";
export type MonthlyPattern = { weekday: number; position: MonthlyPosition };

type DateParts = { year: number; month: number; day: number };

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const POSITIONS: Record<MonthlyPosition, string> = { 1: "primer", 2: "segundo", 3: "tercer", 4: "cuarto", last: "último" };

const pad = (n: number) => String(n).padStart(2, "0");

export function activityLabel(kind: string, index: number | null): string {
  if (kind === "FORM_INITIAL") return "Formulario inicial";
  if (kind === "FORM_FINAL") return "Formulario de sistematización";
  if (kind === "FORM_MONTHLY") return `Seguimiento ${index ?? ""}`.trim();
  if (kind === "ADVANCE") return `Avance ${index ?? ""}`.trim();
  return "Actividad académica";
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function toDateOnly({ year, month, day }: DateParts): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDateOnly(value: string): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Date.UTC lleva los años 0-99 a 1900-1999: fuera de rango no es una fecha de cohorte.
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isDateOnly(value: string): boolean {
  return parseDateOnly(value) !== null;
}

export function monthlyPatternOf(date: string): MonthlyPattern | null {
  const parts = parseDateOnly(date);
  if (!parts) return null;
  const { year, month, day } = parts;
  const position: MonthlyPosition = day + 7 > daysInMonth(year, month) ? "last" : (Math.ceil(day / 7) as 1 | 2 | 3 | 4);
  return { weekday: weekdayOf(year, month, day), position };
}

function dateInMonth(year: number, month: number, pattern: MonthlyPattern): string {
  const days = daysInMonth(year, month);
  const day =
    pattern.position === "last"
      ? days - ((weekdayOf(year, month, days) - pattern.weekday + 7) % 7)
      : 1 + ((pattern.weekday - weekdayOf(year, month, 1) + 7) % 7) + 7 * (pattern.position - 1);
  return toDateOnly({ year, month, day });
}

// Las tres fechas de seguimiento a partir de la fecha base (incluida). null si no es una fecha.
export function monthlyFollowupDates(base: string): { pattern: MonthlyPattern; dates: string[] } | null {
  const parts = parseDateOnly(base);
  const pattern = monthlyPatternOf(base);
  if (!parts || !pattern) return null;
  const dates = Array.from({ length: FOLLOWUP_COUNT }, (_, i) => {
    const total = parts.year * 12 + (parts.month - 1) + i;
    return dateInMonth(Math.floor(total / 12), (total % 12) + 1, pattern);
  });
  return { pattern, dates };
}

export function describeMonthlyPattern(pattern: MonthlyPattern): string {
  return `${POSITIONS[pattern.position]} ${WEEKDAYS[pattern.weekday]} de cada mes`;
}

// "2026-10-03" -> "03/10/2026", sin pasar por Date.
export function formatDateOnly(date: string): string {
  const parts = parseDateOnly(date);
  return parts ? `${pad(parts.day)}/${pad(parts.month)}/${parts.year}` : date;
}

export type FollowupPlan = {
  pattern: MonthlyPattern | null;
  // Las que se guardan: vacío si la fecha base no es válida.
  dates: string[];
  source: "pattern" | "saved";
  // Las que da el patrón, para avisar cuando las guardadas no lo siguen.
  patternDates: string[];
  followsPattern: boolean;
};

// Qué fechas de seguimiento guardar. Las ya guardadas se conservan tal cual mientras el docente no
// cambie la fecha base ni pida recalcularlas (keepSaved): así, guardar otro dato de la cohorte no
// mueve fechas ni hace que Google reenvíe las invitaciones. Las cohortes creadas con la regla
// anterior (mismo número de día cada mes) quedan como están hasta que el docente las recalcule.
export function planMonthlyFollowups(input: { base: string; saved: readonly string[]; keepSaved: boolean }): FollowupPlan {
  const generated = monthlyFollowupDates(input.base);
  const patternDates = generated?.dates ?? [];
  const pattern = generated?.pattern ?? null;
  const savedComplete =
    input.saved.length === FOLLOWUP_COUNT && input.saved.every(isDateOnly) && input.saved[0] === input.base.trim();

  if (input.keepSaved && savedComplete && generated) {
    const dates = [...input.saved];
    return { pattern, dates, source: "saved", patternDates, followsPattern: dates.every((d, i) => d === patternDates[i]) };
  }
  return { pattern, dates: patternDates, source: "pattern", patternDates, followsPattern: true };
}
