// src/lib/calendar/googleInvitations.ts
//
// Llamadas a Google Calendar como organizador (solo servidor). Cada invitación es un evento en el
// calendario del organizador con un único invitado (el estudiante) y sendUpdates=all, para que
// Google le envíe la invitación, los cambios y la cancelación por correo. Los invitados no ven a
// otros invitados ni pueden modificar el evento.
//
// Reintentos: 429, 5xx, límites de frecuencia (403 rateLimitExceeded) y fallos de red, hasta 3
// intentos con espera creciente (o la que pida Retry-After, máx. 5 s). Es seguro reintentar porque
// el ID del evento es determinista: un alta repetida responde 409 y se convierte en actualización.
// fetch y sleep se inyectan para las pruebas.

import type { InvitationEvent } from "./invitationContent";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GoogleDeps = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

export type GoogleFailure = "TOKEN_INVALID" | "RATE_LIMITED" | "FORBIDDEN" | "BAD_REQUEST" | "GOOGLE_ERROR";

export type InvitationResult =
  | { ok: true; outcome: "created" | "updated" | "cancelled" | "already_gone" }
  | { ok: false; error: GoogleFailure; status: number };

const RETRYABLE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "usageLimits"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function errorReason(res: Response): Promise<string | null> {
  const json: unknown = await res.json().catch(() => null);
  if (!json || typeof json !== "object") return null;
  const error = (json as { error?: { errors?: Array<{ reason?: unknown }> } }).error;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === "string" ? reason : null;
}

function retryDelay(res: Response | null, attempt: number): number {
  const header = res?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

type Attempt = { res: Response; reason: string | null } | { res: null; reason: "NETWORK" };

async function send(url: string, init: RequestInit, deps: GoogleDeps): Promise<Attempt> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 3;
  let last: Attempt = { res: null, reason: "NETWORK" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await doFetch(url, init);
    } catch {
      last = { res: null, reason: "NETWORK" };
    }
    if (res) {
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 403 && res.status !== 429)) {
        return { res, reason: null };
      }
      const reason = res.status === 403 || res.status === 429 ? await errorReason(res.clone()) : null;
      last = { res, reason };
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== null && RETRYABLE_REASONS.has(reason));
      if (!retryable) return last;
    }
    if (attempt < maxAttempts) await sleep(retryDelay(res, attempt));
  }
  return last;
}

function failure(attempt: Attempt): InvitationResult {
  if (!attempt.res) return { ok: false, error: "GOOGLE_ERROR", status: 0 };
  const { status } = attempt.res;
  if (status === 401) return { ok: false, error: "TOKEN_INVALID", status };
  if (status === 429 || (attempt.reason && (RETRYABLE_REASONS.has(attempt.reason) || QUOTA_REASONS.has(attempt.reason)))) {
    return { ok: false, error: "RATE_LIMITED", status };
  }
  if (status === 403) return { ok: false, error: "FORBIDDEN", status };
  if (status === 400) return { ok: false, error: "BAD_REQUEST", status };
  return { ok: false, error: "GOOGLE_ERROR", status };
}

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const path = eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  return `${path}?sendUpdates=all`;
}

export function invitationBody(event: InvitationEvent): Record<string, unknown> {
  return {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.startDateTime, timeZone: event.timeZone },
    end: { dateTime: event.endDateTime, timeZone: event.timeZone },
    attendees: [{ email: event.attendeeEmail }],
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: false,
    visibility: "private",
    transparency: "transparent",
    // Los recordatorios del organizador no se aplican a los invitados: cada estudiante recibe
    // los avisos que tenga configurados por defecto en su calendario.
    reminders: { useDefault: true },
    source: { title: "OPT-IA", url: event.appUrl },
  };
}

function jsonInit(method: string, accessToken: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

// Crea o actualiza la invitación con ese ID. mode "create": alta (si ya existía, incluso
// cancelada, se actualiza y se confirma). mode "update": actualización (si ya no existe, se crea).
export async function upsertInvitation(
  params: { accessToken: string; calendarId: string; eventId: string; event: InvitationEvent; mode: "create" | "update" },
  deps: GoogleDeps = {},
): Promise<InvitationResult> {
  const body = invitationBody(params.event);
  const insert = () => send(eventsUrl(params.calendarId), jsonInit("POST", params.accessToken, { id: params.eventId, ...body }), deps);
  const patch = () =>
    send(eventsUrl(params.calendarId, params.eventId), jsonInit("PATCH", params.accessToken, { ...body, status: "confirmed" }), deps);

  // Un alta que responde 409 ya existe (quizá cancelada, o creada por un intento cuya respuesta se
  // perdió): se actualiza en su lugar.
  const insertOrPatch = async (): Promise<InvitationResult> => {
    const created = await insert();
    if (created.res?.ok) return { ok: true, outcome: "created" };
    if (created.res?.status !== 409) return failure(created);
    const updated = await patch();
    return updated.res?.ok ? { ok: true, outcome: "updated" } : failure(updated);
  };

  if (params.mode === "create") return insertOrPatch();

  const updated = await patch();
  if (updated.res?.ok) return { ok: true, outcome: "updated" };
  if (updated.res?.status !== 404 && updated.res?.status !== 410) return failure(updated);
  return insertOrPatch();
}

// Cancela la invitación: Google avisa al estudiante. Si el evento ya no existe, no es un error.
export async function cancelInvitation(
  params: { accessToken: string; calendarId: string; eventId: string },
  deps: GoogleDeps = {},
): Promise<InvitationResult> {
  const res = await send(eventsUrl(params.calendarId, params.eventId), jsonInit("DELETE", params.accessToken), deps);
  if (res.res?.ok) return { ok: true, outcome: "cancelled" };
  if (res.res?.status === 404 || res.res?.status === 410) return { ok: true, outcome: "already_gone" };
  return failure(res);
}
