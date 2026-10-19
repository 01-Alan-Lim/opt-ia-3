// src/lib/calendar/invitationContent.ts
//
// Contenido de cada invitación de Calendar (puro, sin red). Solo lleva datos académicos
// genéricos: la actividad, su fecha, el enlace del formulario de la cohorte y el de OPT-IA. Nunca
// la empresa, el nombre del estudiante, su RU ni el nombre de la cohorte. El ID del evento es
// determinista (organizador + evento de cohorte + estudiante): repetir una sincronización, o dos a
// la vez, nunca crea un segundo evento.

import { createHash } from "node:crypto";

export const DEFAULT_CALENDAR_TIMEZONE = "America/La_Paz";
const DURATION_MINUTES = 30;

export type CohortEventRow = {
  id: string;
  cohort_id: string;
  event_kind: string;
  event_index: number | null;
  event_date: string;
  is_enabled: boolean;
};

export type CohortCalendarSettings = {
  id: string;
  reminder_hour: number | null;
  reminder_minute: number | null;
  form_initial_url: string | null;
  form_monthly_url: string | null;
  form_final_url: string | null;
};

export type InvitationEvent = {
  summary: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  attendeeEmail: string;
  appUrl: string;
};

export function calendarTimeZone(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const tz = (env.DEFAULT_TIMEZONE ?? "").trim();
  if (!tz) return DEFAULT_CALENDAR_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_CALENDAR_TIMEZONE;
  }
}

// Enlace a OPT-IA dentro de la invitación: el dominio de producción si Vercel lo expone
// (VERCEL_PROJECT_PRODUCTION_URL), para que el contenido no cambie según desde qué despliegue se
// sincronice; si no, el origen de la petición.
export function invitationAppUrl(origin: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const production = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (production && /^[a-z0-9.-]+(:\d+)?$/i.test(production)) return `https://${production}`;
  return origin;
}

// Títulos de las invitaciones: son los de las ya enviadas y no siguen a los del panel docente
// (Seguimiento N, Formulario de sistematización). Cambiarlos cambia la huella del contenido y la
// próxima sincronización mandaría un aviso de actualización a cada estudiante.
export function activityLabel(kind: string, index: number | null): string {
  if (kind === "FORM_INITIAL") return "Formulario inicial";
  if (kind === "FORM_FINAL") return "Formulario final";
  if (kind === "FORM_MONTHLY") return `Formulario mensual ${index ?? ""}`.trim();
  if (kind === "ADVANCE") return `Avance ${index ?? ""}`.trim();
  return "Actividad académica";
}

function formUrl(kind: string, cohort: CohortCalendarSettings): string | null {
  const url = kind === "FORM_INITIAL" ? cohort.form_initial_url : kind === "FORM_MONTHLY" ? cohort.form_monthly_url : kind === "FORM_FINAL" ? cohort.form_final_url : null;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

function clampInt(value: number | null, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// Hora local de la cohorte (reminder_hour:reminder_minute), 30 minutos, sin pasar de medianoche.
function eventTimes(date: string, hour: number, minute: number): { start: string; end: string } {
  const startMinutes = hour * 60 + minute;
  const endMinutes = Math.min(startMinutes + DURATION_MINUTES, 23 * 60 + 59);
  const end = endMinutes > startMinutes ? endMinutes : startMinutes;
  return {
    start: `${date}T${pad(hour)}:${pad(minute)}:00`,
    end: `${date}T${pad(Math.floor(end / 60))}:${pad(end % 60)}:00`,
  };
}

export function buildInvitationEvent(params: {
  event: CohortEventRow;
  cohort: CohortCalendarSettings;
  attendeeEmail: string;
  appUrl: string;
  timeZone: string;
}): InvitationEvent {
  const { event, cohort } = params;
  const label = activityLabel(event.event_kind, event.event_index);
  const hour = clampInt(cohort.reminder_hour, 0, 23, 11);
  const minute = clampInt(cohort.reminder_minute, 0, 59, 0);
  const { start, end } = eventTimes(event.event_date, hour, minute);
  const link = formUrl(event.event_kind, cohort);
  const lines = [
    `Actividad: ${label}`,
    `Fecha: ${event.event_date}`,
    ...(link ? [`Formulario: ${link}`] : []),
    `OPT-IA: ${params.appUrl}`,
    "",
    "Recordatorio académico enviado automáticamente por OPT-IA.",
  ];
  return {
    summary: `OPT-IA · ${label}`,
    description: lines.join("\n"),
    startDateTime: start,
    endDateTime: end,
    timeZone: params.timeZone,
    attendeeEmail: params.attendeeEmail,
    appUrl: params.appUrl,
  };
}

// Huella del contenido enviado: si no cambia, no se vuelve a llamar a Google.
export function invitationContentHash(event: InvitationEvent, organizer: { email: string; calendarId: string }): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        organizer.email,
        organizer.calendarId,
        event.attendeeEmail,
        event.summary,
        event.description,
        event.startDateTime,
        event.endDateTime,
        event.timeZone,
      ]),
    )
    .digest("hex");
}

// Google exige IDs en base32hex (0-9 y a-v), de 5 a 1024 caracteres. "optia" y el hex de
// sha256 (0-9, a-f) cumplen; con el organizador en la huella, dos cuentas nunca comparten ID.
export function invitationEventId(organizerEmail: string, cohortEventId: string, userId: string): string {
  return `optia${createHash("sha256").update(`${organizerEmail.toLowerCase()}|${cohortEventId}|${userId}`).digest("hex")}`;
}

export const BASE32HEX_EVENT_ID = /^[0-9a-v]{5,1024}$/;

// Fecha de hoy (YYYY-MM-DD) en la zona de la cohorte. Los eventos ya pasados no se crean, ni se
// actualizan, ni se cancelan (no se envían avisos sobre fechas pasadas).
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
