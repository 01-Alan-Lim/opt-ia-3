// src/lib/calendar/invitationSync.ts
//
// Reconciliación de invitaciones de Calendar (solo servidor). Compara lo que debería existir con
// lo registrado en user_google_calendar_event_map y llama a Google solo para la diferencia:
//   - debe existir: estudiante aprobado de la cohorte, con un correo que hoy podría entrar
//     (institucional, autorizado o heredado sin revocar), y evento habilitado de su cohorte con
//     fecha de hoy en adelante;
//   - se crea si falta, se actualiza si cambió su contenido (fecha, hora, enlace) y se cancela si
//     ya no corresponde (rechazo, revocación, cambio de cohorte, evento deshabilitado);
//   - los eventos ya pasados no se tocan;
//   - las invitaciones que envió otra cuenta organizadora no se tocan (solo esa cuenta puede).
// Sin duplicados: el ID del evento es determinista y el registro es único por estudiante y evento.
// La aprobación académica nunca depende de esto: quien llama ya guardó su cambio y aquí solo se
// informa del resultado. Límite de tiempo por ejecución: lo que no alcanza queda pendiente y se
// informa para continuar con "Sincronizar".

import { decideStudentAccessForEmails, normalizeEmail } from "@/lib/auth/studentEmailAuthorization";
import { supabaseServer } from "@/lib/supabaseServer";

import { cancelInvitation, upsertInvitation, type GoogleDeps, type GoogleFailure } from "./googleInvitations";
import {
  buildInvitationEvent,
  calendarTimeZone,
  invitationAppUrl,
  invitationContentHash,
  invitationEventId,
  todayIn,
  type CohortCalendarSettings,
  type CohortEventRow,
  type InvitationEvent,
} from "./invitationContent";
import { getOrganizerAccess, recordOrganizerSync } from "./organizer";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAP = "user_google_calendar_event_map";
const MAX_ROWS = 5000;

export type SyncScope =
  | { kind: "user"; userId: string }
  | { kind: "cohort"; cohortId: string }
  | { kind: "all" }
  | { kind: "withdraw" };

export type SyncStatus = "ok" | "partial" | "error" | "organizer_not_connected" | "not_configured";

export type SyncReport = {
  status: SyncStatus;
  message: string;
  created: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  failed: number;
  remaining: number;
  foreign: number;
};

export type SyncOptions = {
  origin: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
  clock?: () => number;
  budgetMs?: number;
  concurrency?: number;
};

type MapRow = {
  id: string;
  user_id: string;
  cohort_event_id: string;
  calendar_id: string;
  google_event_id: string;
  status: "invited" | "cancelled";
  organizer_email: string | null;
  content_hash: string | null;
};

type ProfileRow = {
  user_id: string;
  email: string | null;
  role: string | null;
  cohort_id: string | null;
  registration_status: string | null;
};

type Desired = { userId: string; event: CohortEventRow; content: InvitationEvent; hash: string };

type Op =
  | { kind: "create" | "update"; desired: Desired; row: MapRow | null }
  | { kind: "cancel"; row: MapRow }
  | { kind: "mark_cancelled"; row: MapRow };

const MAP_SELECT = "id, user_id, cohort_event_id, calendar_id, google_event_id, status, organizer_email, content_hash";
const EVENT_SELECT = "id, cohort_id, event_kind, event_index, event_date, is_enabled";
const COHORT_SELECT = "id, reminder_hour, reminder_minute, form_initial_url, form_monthly_url, form_final_url";

const ROW_ERRORS: Record<GoogleFailure, (status: number) => string> = {
  TOKEN_INVALID: () => "Google rechazó el acceso de la cuenta organizadora.",
  RATE_LIMITED: () => "Google limitó la frecuencia de envíos; se reintentará en la próxima sincronización.",
  FORBIDDEN: () => "Google rechazó la operación (permisos o límites de la cuenta organizadora).",
  BAD_REQUEST: () => "Google rechazó los datos del evento.",
  GOOGLE_ERROR: (status) => (status ? `Google no respondió correctamente (${status}).` : "No se pudo contactar con Google."),
};

const ORGANIZER_MESSAGES = {
  NOT_CONFIGURED: "El calendario no está configurado en el servidor.",
  NOT_CONNECTED: "No hay una cuenta organizadora conectada; no se enviaron invitaciones.",
  UNAVAILABLE: "El calendario no está disponible todavía (falta preparar la base de datos).",
  TOKEN_UNREADABLE: "Este entorno no puede leer la conexión guardada (su clave de cifrado es otra). Si la clave cambió, vuelve a conectar la cuenta organizadora.",
  REVOKED: "Google revocó o caducó el acceso de la cuenta organizadora. Vuelve a conectarla.",
  GOOGLE_UNAVAILABLE: "Google no respondió; se reintentará en la próxima sincronización.",
} as const;

const emptyCounts = { created: 0, updated: 0, cancelled: 0, unchanged: 0, failed: 0, remaining: 0, foreign: 0 };

class SyncDataError extends Error {}

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new SyncDataError("SYNC_READ_FAILED");
  return (data ?? []) as T[];
}

function chunks<T>(items: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function selectIn<T>(table: string, columns: string, column: string, values: string[]): Promise<T[]> {
  const unique = [...new Set(values)];
  const out: T[] = [];
  for (const part of chunks(unique)) {
    out.push(...(await select<T>(supabaseServer.from(table).select(columns).in(column, part).limit(MAX_ROWS))));
  }
  return out;
}

async function loadScope(scope: SyncScope): Promise<{ profiles: ProfileRow[]; rows: MapRow[]; events: CohortEventRow[] }> {
  const profileSelect = "user_id, email, role, cohort_id, registration_status";
  let profiles: ProfileRow[] = [];
  let rows: MapRow[] = [];
  let events: CohortEventRow[] = [];

  if (scope.kind === "user") {
    profiles = await select<ProfileRow>(supabaseServer.from("profiles").select(profileSelect).eq("user_id", scope.userId).limit(1));
    rows = await select<MapRow>(supabaseServer.from(MAP).select(MAP_SELECT).eq("user_id", scope.userId).limit(MAX_ROWS));
    const cohortId = profiles[0]?.cohort_id;
    const current = cohortId ? await select<CohortEventRow>(supabaseServer.from("cohort_events").select(EVENT_SELECT).eq("cohort_id", cohortId).limit(MAX_ROWS)) : [];
    const known = new Set(current.map((e) => e.id));
    const others = await selectIn<CohortEventRow>("cohort_events", EVENT_SELECT, "id", rows.map((r) => r.cohort_event_id).filter((id) => !known.has(id)));
    events = [...current, ...others];
  } else if (scope.kind === "cohort") {
    events = await select<CohortEventRow>(supabaseServer.from("cohort_events").select(EVENT_SELECT).eq("cohort_id", scope.cohortId).limit(MAX_ROWS));
    profiles = await select<ProfileRow>(
      supabaseServer.from("profiles").select(profileSelect).eq("cohort_id", scope.cohortId).eq("registration_status", "approved").limit(MAX_ROWS),
    );
    rows = await selectIn<MapRow>(MAP, MAP_SELECT, "cohort_event_id", events.map((e) => e.id));
  } else {
    rows = await select<MapRow>(supabaseServer.from(MAP).select(MAP_SELECT).limit(MAX_ROWS));
    if (scope.kind === "all") {
      profiles = await select<ProfileRow>(supabaseServer.from("profiles").select(profileSelect).eq("registration_status", "approved").limit(MAX_ROWS));
      const cohortIds = profiles.map((p) => p.cohort_id).filter((id): id is string => Boolean(id));
      events = await selectIn<CohortEventRow>("cohort_events", EVENT_SELECT, "cohort_id", cohortIds);
    }
    const known = new Set(events.map((e) => e.id));
    events.push(...(await selectIn<CohortEventRow>("cohort_events", EVENT_SELECT, "id", rows.map((r) => r.cohort_event_id).filter((id) => !known.has(id)))));
  }
  return { profiles, rows, events };
}

const keyOf = (userId: string, eventId: string) => `${userId}|${eventId}`;

export async function reconcileInvitations(scope: SyncScope, options: SyncOptions): Promise<SyncReport> {
  const access = await getOrganizerAccess({ fetchImpl: options.fetchImpl });
  if (!access.ok) {
    // Sin configurar o sin M3 es un estado del despliegue, no un fallo de esta operación.
    const status: SyncStatus =
      access.reason === "NOT_CONNECTED"
        ? "organizer_not_connected"
        : access.reason === "NOT_CONFIGURED" || access.reason === "UNAVAILABLE"
          ? "not_configured"
          : "error";
    return { status, message: ORGANIZER_MESSAGES[access.reason], ...emptyCounts };
  }
  const accessToken = access.accessToken;
  const organizer = { email: normalizeEmail(access.googleEmail), calendarId: access.calendarId };
  const timeZone = calendarTimeZone();
  const today = todayIn(timeZone, options.now ?? new Date());
  const appUrl = invitationAppUrl(options.origin);

  let profiles: ProfileRow[];
  let rows: MapRow[];
  let events: CohortEventRow[];
  let cohorts: CohortCalendarSettings[];
  let decisions: Awaited<ReturnType<typeof decideStudentAccessForEmails>>;
  try {
    ({ profiles, rows, events } = await loadScope(scope));
    const students = profiles.filter((p) => p.registration_status === "approved" && (p.role ?? "student") === "student" && p.email && p.cohort_id);
    cohorts = await selectIn<CohortCalendarSettings>("cohorts", COHORT_SELECT, "id", students.map((p) => p.cohort_id as string));
    decisions = await decideStudentAccessForEmails(students.map((p) => p.email as string));
    profiles = students;
  } catch {
    // Con datos incompletos no se crea ni se cancela nada.
    return { status: "error", message: "No se pudieron leer los datos de la sincronización; no se cambió ninguna invitación.", ...emptyCounts };
  }

  const eventsById = new Map(events.map((e) => [e.id, e]));
  const cohortsById = new Map(cohorts.map((c) => [c.id, c]));

  // Lo que debería existir.
  const desired = new Map<string, Desired>();
  for (const p of profiles) {
    const email = normalizeEmail(p.email);
    if (!decisions.get(email)?.allowed || email === organizer.email) continue;
    const cohort = cohortsById.get(p.cohort_id as string);
    if (!cohort) continue;
    for (const event of events) {
      if (event.cohort_id !== p.cohort_id || !event.is_enabled || event.event_date < today) continue;
      const content = buildInvitationEvent({ event, cohort, attendeeEmail: email, appUrl, timeZone });
      desired.set(keyOf(p.user_id, event.id), { userId: p.user_id, event, content, hash: invitationContentHash(content, organizer) });
    }
  }

  // Diferencia con lo registrado.
  const ops: Op[] = [];
  let unchanged = 0;
  let foreign = 0;
  const rowsByKey = new Map(rows.map((r) => [keyOf(r.user_id, r.cohort_event_id), r]));
  for (const [key, want] of desired) {
    const row = rowsByKey.get(key) ?? null;
    if (row && row.status === "invited" && row.organizer_email !== organizer.email) {
      foreign++;
      continue;
    }
    if (!row || row.status === "cancelled") ops.push({ kind: "create", desired: want, row });
    else if (row.content_hash !== want.hash) ops.push({ kind: "update", desired: want, row });
    else unchanged++;
  }
  for (const [key, row] of rowsByKey) {
    if (desired.has(key) || row.status !== "invited") continue;
    if (row.organizer_email !== organizer.email) {
      foreign++;
      continue;
    }
    const event = eventsById.get(row.cohort_event_id);
    const past = !event || event.event_date < today;
    if (!past) ops.push({ kind: "cancel", row });
    else if (scope.kind === "withdraw") ops.push({ kind: "mark_cancelled", row });
  }

  // Ejecución con concurrencia limitada y límite de tiempo.
  const deps: GoogleDeps = { fetchImpl: options.fetchImpl, sleep: options.sleep };
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? 45_000);
  const counts = { created: 0, updated: 0, cancelled: 0, failed: 0 };
  let next = 0;
  let started = 0;
  let tokenRejected = false;

  const nowIso = () => new Date().toISOString();
  const saveRow = async (patch: Record<string, unknown>) =>
    !(await supabaseServer.from(MAP).upsert({ ...patch, updated_at: nowIso() }, { onConflict: "user_id,cohort_event_id" })).error;
  const patchRow = async (id: string, patch: Record<string, unknown>) =>
    !(await supabaseServer.from(MAP).update({ ...patch, updated_at: nowIso() }).eq("id", id)).error;

  async function run(op: Op): Promise<void> {
    if (op.kind === "mark_cancelled") {
      if (await patchRow(op.row.id, { status: "cancelled", last_error: null })) counts.cancelled++;
      else counts.failed++;
      return;
    }
    if (op.kind === "cancel") {
      const result = await cancelInvitation({ accessToken, calendarId: op.row.calendar_id, eventId: op.row.google_event_id }, deps);
      if (result.ok) {
        if (await patchRow(op.row.id, { status: "cancelled", last_synced_at: nowIso(), last_error: null })) counts.cancelled++;
        else counts.failed++;
        return;
      }
      if (result.error === "TOKEN_INVALID") tokenRejected = true;
      counts.failed++;
      await patchRow(op.row.id, { last_error: ROW_ERRORS[result.error](result.status) });
      return;
    }

    const { desired: want } = op;
    const eventId = op.kind === "update" && op.row ? op.row.google_event_id : invitationEventId(organizer.email, want.event.id, want.userId);
    const calendarId = op.kind === "update" && op.row ? op.row.calendar_id : organizer.calendarId;
    const result = await upsertInvitation(
      { accessToken, calendarId, eventId, event: want.content, mode: op.kind },
      deps,
    );
    const base = { user_id: want.userId, cohort_event_id: want.event.id, calendar_id: calendarId, google_event_id: eventId, organizer_email: organizer.email };
    if (result.ok) {
      const saved = await saveRow({ ...base, status: "invited", content_hash: want.hash, last_synced_at: nowIso(), last_error: null });
      // Para el estudiante, una alta (aunque Google ya tuviera el evento) es una invitación nueva.
      if (!saved) counts.failed++;
      else if (op.kind === "create") counts.created++;
      else counts.updated++;
      return;
    }
    if (result.error === "TOKEN_INVALID") tokenRejected = true;
    counts.failed++;
    // Queda registrada como pendiente (sin huella): la próxima sincronización la reintenta con el
    // mismo ID, así que no puede duplicarse aunque Google sí la hubiera creado.
    await saveRow({ ...base, status: "invited", content_hash: null, last_error: ROW_ERRORS[result.error](result.status) });
  }

  const workers = Array.from({ length: Math.min(options.concurrency ?? 4, ops.length) }, async () => {
    while (next < ops.length && !tokenRejected && clock() < deadline) {
      const op = ops[next++];
      started++;
      await run(op);
    }
  });
  await Promise.all(workers);

  const remaining = ops.length - started;
  const report: SyncReport = { status: "ok", message: "", ...counts, unchanged, remaining, foreign };

  if (tokenRejected) {
    report.status = "error";
    report.message = ROW_ERRORS.TOKEN_INVALID(401) + " Vuelve a conectarla.";
  } else if (counts.failed > 0) {
    report.status = "error";
    report.message = `${counts.failed} invitaciones no se pudieron sincronizar. Pulsa Sincronizar para reintentar.`;
  } else if (remaining > 0) {
    report.status = "partial";
    report.message = `Quedaron ${remaining} invitaciones pendientes. Pulsa Sincronizar para continuar.`;
  } else if (foreign > 0 && scope.kind === "withdraw") {
    report.status = "partial";
    report.message = `${foreign} invitaciones las envió otra cuenta organizadora; conéctala para retirarlas.`;
  } else {
    report.message = "Invitaciones al día.";
  }
  await recordOrganizerSync(report.status === "ok" ? null : report.message);
  return report;
}

export async function safeReconcile(scope: SyncScope, options: SyncOptions): Promise<SyncReport> {
  try {
    return await reconcileInvitations(scope, options);
  } catch {
    return { status: "error", message: "No se pudo sincronizar el calendario.", ...emptyCounts };
  }
}

// Resumen para el panel docente.
export async function invitationTotals(): Promise<{ invited: number; cancelled: number; withErrors: number } | null> {
  const { data, error } = await supabaseServer.from(MAP).select("status, last_error").limit(MAX_ROWS);
  if (error) return null;
  const rows = (data ?? []) as Array<{ status: string; last_error: string | null }>;
  return {
    invited: rows.filter((r) => r.status === "invited" && !r.last_error).length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    withErrors: rows.filter((r) => r.last_error).length,
  };
}
