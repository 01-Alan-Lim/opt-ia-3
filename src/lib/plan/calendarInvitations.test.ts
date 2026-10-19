import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { NextRequest } from "next/server";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, nextTimestamp, type RestRow, type RestStubState } from "./restStubHarness";

// Invitaciones automáticas de Google Calendar desde la cuenta organizadora: contenido (sin datos
// privados), IDs deterministas en base32hex, cliente de Google con reintentos, y la
// reconciliación ejecutada por las rutas reales (aprobar, rechazar, revocar y volver a autorizar
// un correo, cambiar fechas, deshabilitar un evento, cambiar de cohorte, retirar todo). Google
// Calendar y Supabase simulados en memoria, sin red. Se comprueba que no hay duplicados (también
// con dos sincronizaciones a la vez) y que la aprobación se guarda aunque Google falle.

type Json = Record<string, unknown>;

const TEACHER = { id: "10000000-0000-4000-8000-000000000001", email: "docente@gmail.com" };
const ANA = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const BETO = { id: "30000000-0000-4000-8000-000000000003", email: "beto@gmail.com" };
const CARLA = { id: "40000000-0000-4000-8000-000000000004", email: "carla@gmail.com" };
const LEGADO = { id: "50000000-0000-4000-8000-000000000005", email: "legado@gmail.com" };
const DIEGO = { id: "60000000-0000-4000-8000-000000000006", email: "diego@umsa.bo" };
const EVA = { id: "70000000-0000-4000-8000-000000000007", email: "eva@umsa.bo" };
const FRAN = { id: "80000000-0000-4000-8000-000000000008", email: "fran@umsa.bo" };
const GABY = { id: "90000000-0000-4000-8000-000000000009", email: "gaby@umsa.bo" };
const C1 = "c1000000-0000-4000-8000-000000000001";
const C2 = "c2000000-0000-4000-8000-000000000002";
const ORGANIZER = "optia.organizador@gmail.com";
const ACCESS_TOKEN = "ya29.acceso-calendar";
const REFRESH_TOKEN = "1//refresh-organizador-secreto";
const KEY = randomBytes(32).toString("base64");
const ORIGIN = "https://opt-ia.test";
const PRIVATE = ["Empresa Secreta SRL", "Cohorte Secreta 2026", "7654321", "Beto", "Prueba", "Ana"];

const TZ = "America/La_Paz";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function day(offset: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const EV = {
  initial: "e0000000-0000-4000-8000-000000000001",
  monthly1: "e0000000-0000-4000-8000-000000000002",
  advance1: "e0000000-0000-4000-8000-000000000003",
  monthly2: "e0000000-0000-4000-8000-000000000004",
  final: "e0000000-0000-4000-8000-000000000005",
  c2: "e0000000-0000-4000-8000-000000000006",
};

const student = (u: { id: string; email: string }, cohort: string, status: string, extra: Json = {}): RestRow => ({
  user_id: u.id,
  email: u.email,
  role: "student",
  ru: "7654321",
  first_name: "Beto",
  last_name: "Prueba",
  semester: "1",
  company_name: "Empresa Secreta SRL",
  cohort_id: cohort,
  registration_status: status,
  ...extra,
});

const state: RestStubState = {
  user: TEACHER,
  tables: {
    cohorts: [
      {
        id: C1,
        name: "Cohorte Secreta 2026",
        is_active: true,
        registration_opens_at: null,
        access_starts_at: null,
        access_ends_at: null,
        reminder_hour: 9,
        reminder_minute: 30,
        form_initial_url: "https://forms.gle/inicial",
        form_monthly_url: "https://forms.gle/mensual",
        form_final_url: "https://forms.gle/final",
      },
      { id: C2, name: "Otra", is_active: true, registration_opens_at: null, access_starts_at: null, access_ends_at: null, reminder_hour: 11, reminder_minute: 0 },
    ],
    cohort_events: [
      { id: EV.initial, cohort_id: C1, event_kind: "FORM_INITIAL", event_index: null, event_key: "FORM_INITIAL:_", event_date: day(-10), remind_before_days: 2, is_enabled: true },
      { id: EV.monthly1, cohort_id: C1, event_kind: "FORM_MONTHLY", event_index: 1, event_key: "FORM_MONTHLY:1", event_date: day(5), remind_before_days: 2, is_enabled: true },
      { id: EV.advance1, cohort_id: C1, event_kind: "ADVANCE", event_index: 1, event_key: "ADVANCE:1", event_date: day(12), remind_before_days: 2, is_enabled: true },
      { id: EV.monthly2, cohort_id: C1, event_kind: "FORM_MONTHLY", event_index: 2, event_key: "FORM_MONTHLY:2", event_date: day(40), remind_before_days: 2, is_enabled: true },
      { id: EV.final, cohort_id: C1, event_kind: "FORM_FINAL", event_index: null, event_key: "FORM_FINAL:_", event_date: day(60), remind_before_days: 2, is_enabled: false },
      { id: EV.c2, cohort_id: C2, event_kind: "ADVANCE", event_index: 1, event_key: "ADVANCE:1", event_date: day(8), remind_before_days: 2, is_enabled: true },
    ],
    profiles: [
      student(ANA, C1, "pending", { first_name: "Ana" }),
      student(BETO, C1, "approved"),
      student(CARLA, C1, "approved"),
      student(LEGADO, C1, "approved"),
      student(DIEGO, C2, "approved"),
      { user_id: TEACHER.id, email: TEACHER.email, role: "teacher", cohort_id: C1, registration_status: "approved" },
    ],
    student_email_authorizations: [
      { id: "a1", email: BETO.email, note: null, authorized_by: TEACHER.id, created_at: "2026-10-01T10:00:00Z", revoked_at: null, revoked_by: null },
      { id: "a2", email: CARLA.email, note: null, authorized_by: TEACHER.id, created_at: "2026-10-01T10:00:00Z", revoked_at: "2026-10-02T10:00:00Z", revoked_by: TEACHER.id },
    ],
    calendar_organizer: [],
    user_google_calendar_event_map: [],
  },
  uniques: {
    student_email_authorizations: [
      { name: "student_email_authorizations_active_email_key", columns: ["email"], where: (r) => r.revoked_at === null || r.revoked_at === undefined },
    ],
    user_google_calendar_event_map: [{ name: "user_google_calendar_event_map_user_event_unique", columns: ["user_id", "cohort_event_id"] }],
    calendar_organizer: [{ name: "calendar_organizer_pkey", columns: ["id"] }],
  },
  defaults: {
    student_email_authorizations: () => ({ id: crypto.randomUUID(), note: null, created_at: nextTimestamp(), revoked_at: null, revoked_by: null }),
    user_google_calendar_event_map: () => ({ id: crypto.randomUUID(), calendar_id: "primary", status: "invited", content_hash: null, last_error: null, created_at: nextTimestamp() }),
  },
};

// ---------------- Google simulado (OAuth + Calendar) ----------------
type GEvent = { status: "confirmed" | "cancelled"; body: Json };
const gcal = {
  events: new Map<string, GEvent>(),
  calls: [] as { method: string; id: string | null; body: Json | null }[],
  failAlways: 0,
  failNext: [] as number[],
  createThenFail: 0,
  refresh: "ok" as "ok" | "invalid_grant",
  tokenRefreshes: 0,
};
const jsonRes = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function google(req: Request, url: URL): Promise<Response | null> {
  if (url.host === "oauth2.googleapis.com") {
    if (url.pathname === "/revoke") return new Response("", { status: 200 });
    const form = new URLSearchParams(await req.text());
    assert.equal(form.get("refresh_token"), REFRESH_TOKEN);
    gcal.tokenRefreshes++;
    if (gcal.refresh === "invalid_grant") return jsonRes({ error: "invalid_grant" }, 400);
    return jsonRes({ access_token: ACCESS_TOKEN, expires_in: 3599 });
  }
  if (url.host !== "www.googleapis.com") return null;
  const m = /^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(url.pathname);
  assert.ok(m, `ruta de Calendar inesperada: ${url.pathname}`);
  assert.equal(url.searchParams.get("sendUpdates"), "all", "Google avisa siempre al estudiante");
  assert.equal(req.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
  const body = req.method === "POST" || req.method === "PATCH" ? ((await req.json()) as Json) : null;
  const id = m[1] ? decodeURIComponent(m[1]) : typeof body?.id === "string" ? body.id : null;
  gcal.calls.push({ method: req.method, id, body });

  const fail = gcal.failNext.shift() ?? gcal.failAlways;
  if (fail) return jsonRes({ error: { code: fail, errors: [{ reason: fail === 403 ? "rateLimitExceeded" : "backendError" }] } }, fail);
  assert.ok(id, "todas las operaciones llevan ID");
  const existing = gcal.events.get(id);

  if (req.method === "POST") {
    if (existing) return jsonRes({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, 409);
    gcal.events.set(id, { status: "confirmed", body: body ?? {} });
    if (gcal.createThenFail > 0) {
      gcal.createThenFail--;
      return jsonRes({ error: { code: 503 } }, 503);
    }
    return jsonRes({ id, status: "confirmed" });
  }
  if (req.method === "PATCH") {
    if (!existing) return jsonRes({ error: { code: 404 } }, 404);
    existing.body = { ...existing.body, ...(body ?? {}) };
    existing.status = body?.status === "confirmed" ? "confirmed" : existing.status;
    return jsonRes({ id, status: existing.status });
  }
  if (req.method === "DELETE") {
    if (!existing || existing.status === "cancelled") return jsonRes({ error: { code: 410 } }, 410);
    existing.status = "cancelled";
    return new Response(null, { status: 204 });
  }
  return jsonRes({ error: { code: 405 } }, 405);
}

// ---------------- Logs capturados ----------------
const logs: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer token-de-prueba" },
    body: method === "POST" || method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
  });
}

const mapRows = () => state.tables.user_google_calendar_event_map;
const rowsOf = (u: { id: string }) => mapRows().filter((r) => r.user_id === u.id);
const confirmedFor = (email: string) =>
  [...gcal.events.values()].filter((e) => e.status === "confirmed" && JSON.stringify(e.body.attendees) === JSON.stringify([{ email }]));
const callsSince = (n: number) => gcal.calls.slice(n);

async function main() {
  prepareRouteTestEnv({
    ALLOWED_EMAIL_DOMAIN: "umsa.bo",
    TEACHER_EMAIL_ALLOWLIST: TEACHER.email,
    STUDENT_TEST_EMAIL_ALLOWLIST: LEGADO.email,
    CALENDAR_TOKEN_ENCRYPTION_KEY: KEY,
    NEXT_PUBLIC_CALENDAR_TOKEN_ENCRYPTION_KEY: undefined,
    GOOGLE_OAUTH_CLIENT_ID: "cliente.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-de-prueba",
    DEFAULT_TIMEZONE: undefined,
    VERCEL_PROJECT_PRODUCTION_URL: undefined,
  });
  const content = await import("../calendar/invitationContent");
  const gapi = await import("../calendar/googleInvitations");
  const sync = await import("../calendar/invitationSync");
  const cipher = await import("../calendar/tokenCipher");
  const approve = await import("../../app/api/teacher/students/approve/route");
  const emails = await import("../../app/api/teacher/authorized-emails/route");
  const cohortSync = await import("../../app/api/teacher/cohorts/[id]/calendar/sync/route");
  const cohortEvents = await import("../../app/api/teacher/cohorts/[id]/events/route");
  const organizerSync = await import("../../app/api/teacher/calendar-organizer/sync/route");
  const withdraw = await import("../../app/api/teacher/calendar-organizer/withdraw/route");
  const onboarding = await import("../../app/api/onboarding/submit/route");
  const { clearStudentEmailAuthorizationCache } = await import("../auth/studentEmailAuthorization");
  const { calendarReportText } = await import("../calendar/syncReportText");

  // =============== Textos para el docente ===============
  const quiet = { quietWhenNotConnected: true };
  assert.equal(calendarReportText({ status: "ok", created: 3 }), "Calendario: 3 invitaciones enviadas.");
  assert.equal(calendarReportText({ status: "ok", created: 1, updated: 2, cancelled: 1 }), "Calendario: 1 invitación enviada, 2 actualizadas, 1 cancelada.");
  assert.equal(calendarReportText({ status: "ok" }), "Calendario: invitaciones al día.");
  assert.equal(calendarReportText({ status: "ok" }, quiet), "");
  assert.equal(calendarReportText({ status: "organizer_not_connected" }, quiet), "", "en aprobaciones no se repite");
  assert.ok(calendarReportText({ status: "organizer_not_connected" }).includes("conecta la cuenta organizadora"));
  assert.equal(calendarReportText({ status: "not_configured", message: "x" }, quiet), "");
  assert.equal(calendarReportText({ status: "error", message: "Google no respondió." }, quiet), "Calendario: Google no respondió.", "los fallos sí se muestran");
  assert.equal(calendarReportText(null), "");

  // =============== Contenido e ID (puro) ===============
  const cohortRow = state.tables.cohorts[0] as unknown as Parameters<typeof content.buildInvitationEvent>[0]["cohort"];
  const evRow = (id: string) => state.tables.cohort_events.find((e) => e.id === id) as unknown as Parameters<typeof content.buildInvitationEvent>[0]["event"];
  const built = content.buildInvitationEvent({ event: evRow(EV.monthly1), cohort: cohortRow, attendeeEmail: BETO.email, appUrl: ORIGIN, timeZone: TZ });
  assert.equal(built.summary, "OPT-IA · Formulario mensual 1");
  assert.equal(built.startDateTime, `${day(5)}T09:30:00`);
  assert.equal(built.endDateTime, `${day(5)}T10:00:00`);
  assert.ok(built.description.includes("Formulario: https://forms.gle/mensual"));
  assert.ok(built.description.includes(`OPT-IA: ${ORIGIN}`));
  for (const secret of PRIVATE) assert.ok(!`${built.summary}\n${built.description}`.includes(secret), `sin dato privado: ${secret}`);
  const late = content.buildInvitationEvent({ event: evRow(EV.advance1), cohort: { ...cohortRow, reminder_hour: 23, reminder_minute: 45 }, attendeeEmail: BETO.email, appUrl: ORIGIN, timeZone: TZ });
  assert.equal(late.endDateTime, `${day(12)}T23:59:00`, "no pasa de medianoche");
  assert.ok(!content.buildInvitationEvent({ event: evRow(EV.advance1), cohort: cohortRow, attendeeEmail: BETO.email, appUrl: ORIGIN, timeZone: TZ }).description.includes("Formulario:"), "un avance no lleva formulario");
  const bad = content.buildInvitationEvent({ event: evRow(EV.monthly1), cohort: { ...cohortRow, form_monthly_url: "javascript:alert(1)" }, attendeeEmail: BETO.email, appUrl: ORIGIN, timeZone: TZ });
  assert.ok(!bad.description.includes("javascript:"), "solo enlaces http(s)");
  assert.equal(content.calendarTimeZone({}), "America/La_Paz");
  assert.equal(content.calendarTimeZone({ DEFAULT_TIMEZONE: "No/Existe" }), "America/La_Paz");
  assert.equal(content.calendarTimeZone({ DEFAULT_TIMEZONE: "America/Lima" }), "America/Lima");
  assert.equal(content.invitationAppUrl(ORIGIN, {}), ORIGIN);
  assert.equal(content.invitationAppUrl("https://preview.vercel.app", { VERCEL_PROJECT_PRODUCTION_URL: "opt-ia.vercel.app" }), "https://opt-ia.vercel.app");

  const id1 = content.invitationEventId(ORGANIZER, EV.monthly1, BETO.id);
  assert.match(id1, content.BASE32HEX_EVENT_ID, "base32hex: 0-9 y a-v");
  assert.ok(id1.length >= 5 && id1.length <= 1024);
  assert.equal(content.invitationEventId(ORGANIZER.toUpperCase(), EV.monthly1, BETO.id), id1, "determinista");
  assert.notEqual(content.invitationEventId(ORGANIZER, EV.monthly1, ANA.id), id1);
  assert.notEqual(content.invitationEventId(ORGANIZER, EV.advance1, BETO.id), id1);
  assert.notEqual(content.invitationEventId("otra@gmail.com", EV.monthly1, BETO.id), id1, "otra cuenta, otro ID");
  const h1 = content.invitationContentHash(built, { email: ORGANIZER, calendarId: "primary" });
  assert.equal(content.invitationContentHash({ ...built }, { email: ORGANIZER, calendarId: "primary" }), h1);
  assert.notEqual(content.invitationContentHash({ ...built, startDateTime: `${day(6)}T09:30:00` }, { email: ORGANIZER, calendarId: "primary" }), h1);

  // =============== Cliente de Google: cuerpo, 409, 404 y reintentos ===============
  {
    const seen: { method: string; url: string; body: Json | null }[] = [];
    // Cada respuesta: un estado HTTP, -1 (fallo de red) o [estado, motivo de Google].
    let script: Array<number | [number, string]> = [];
    const sleeps: number[] = [];
    const fake = async (input: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url: input, body: init?.body ? (JSON.parse(String(init.body)) as Json) : null });
      const next = script.shift() ?? 200;
      const [status, reason] = Array.isArray(next) ? next : [next, "backendError"];
      if (status === -1) throw new TypeError("fetch failed");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (status === 429) headers["retry-after"] = "2";
      return new Response(status === 204 ? null : JSON.stringify({ error: { errors: [{ reason }] } }), { status, headers });
    };
    const deps = { fetchImpl: fake, sleep: async (ms: number) => void sleeps.push(ms) };
    const params = { accessToken: "tok", calendarId: "primary", eventId: id1, event: built };

    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: true, outcome: "created" });
    const insert = seen[0];
    assert.equal(insert.method, "POST");
    assert.equal(insert.url, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all");
    assert.equal(insert.body?.id, id1);
    assert.deepEqual(insert.body?.attendees, [{ email: BETO.email }], "un único invitado");
    assert.equal(insert.body?.guestsCanSeeOtherGuests, false);
    assert.equal(insert.body?.guestsCanInviteOthers, false);
    assert.equal(insert.body?.guestsCanModify, false);
    assert.equal(insert.body?.visibility, "private");
    assert.deepEqual(insert.body?.reminders, { useDefault: true });
    assert.deepEqual(insert.body?.start, { dateTime: `${day(5)}T09:30:00`, timeZone: TZ });

    seen.length = 0;
    script = [409, 200];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: true, outcome: "updated" }, "409: ya existía (o se canceló): se actualiza");
    assert.equal(seen[1].method, "PATCH");
    assert.equal(seen[1].url, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id1}?sendUpdates=all`);
    assert.equal(seen[1].body?.status, "confirmed", "se reactiva si estaba cancelado");

    seen.length = 0;
    script = [404, 200];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "update" }, deps), { ok: true, outcome: "created" }, "si ya no existe, se crea");
    assert.deepEqual(seen.map((s) => s.method), ["PATCH", "POST"]);

    seen.length = 0;
    sleeps.length = 0;
    script = [503, -1, 200];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: true, outcome: "created" }, "503 y fallo de red se reintentan");
    assert.equal(seen.length, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1] > sleeps[0], "espera creciente");

    seen.length = 0;
    sleeps.length = 0;
    script = [429, 429, 429];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: false, error: "RATE_LIMITED", status: 429 });
    assert.equal(seen.length, 3, "máximo 3 intentos");
    assert.deepEqual(sleeps, [2000, 2000], "respeta Retry-After");

    seen.length = 0;
    script = [[403, "rateLimitExceeded"], 200];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: true, outcome: "created" }, "403 rateLimitExceeded se reintenta");
    seen.length = 0;
    script = [[403, "forbiddenForNonOrganizer"]];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: false, error: "FORBIDDEN", status: 403 });
    assert.equal(seen.length, 1, "403 sin límite de frecuencia: sin reintento");
    script = [[403, "quotaExceeded"]];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: false, error: "RATE_LIMITED", status: 403 });

    // Actualización de un evento que ya no está y cuyo nuevo alta se repite: termina en PATCH.
    seen.length = 0;
    script = [404, 503, 409, 200];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "update" }, deps), { ok: true, outcome: "updated" });
    assert.deepEqual(seen.map((s) => s.method), ["PATCH", "POST", "POST", "PATCH"]);

    script = [401];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: false, error: "TOKEN_INVALID", status: 401 });
    script = [400];
    assert.deepEqual(await gapi.upsertInvitation({ ...params, mode: "create" }, deps), { ok: false, error: "BAD_REQUEST", status: 400 });

    seen.length = 0;
    script = [204];
    assert.deepEqual(await gapi.cancelInvitation({ accessToken: "tok", calendarId: "primary", eventId: id1 }, deps), { ok: true, outcome: "cancelled" });
    assert.equal(seen[0].method, "DELETE");
    assert.ok(seen[0].url.endsWith(`/events/${id1}?sendUpdates=all`));
    script = [410];
    assert.deepEqual(await gapi.cancelInvitation({ accessToken: "tok", calendarId: "primary", eventId: id1 }, deps), { ok: true, outcome: "already_gone" });
    script = [404];
    assert.deepEqual(await gapi.cancelInvitation({ accessToken: "tok", calendarId: "primary", eventId: id1 }, deps), { ok: true, outcome: "already_gone" });
  }

  // =============== Reconciliación con las rutas reales ===============
  const stub = installRestStub(state, google);
  const cohortCtx = (id: string) => ({ params: Promise.resolve({ id }) });
  const runCohortSync = async (id = C1) => {
    const res = await cohortSync.POST(request("POST", `/api/teacher/cohorts/${id}/calendar/sync`), cohortCtx(id));
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: { calendar: Json } }).data.calendar;
  };
  const approveAs = async (u: { id: string }, status: "approved" | "rejected") => {
    const res = await approve.POST(request("POST", "/api/teacher/students/approve", { user_id: u.id, status }));
    const json = (await res.json()) as { data: { student: Json; calendar: Json } };
    assert.equal(res.status, 200);
    return json.data;
  };

  // Antes de aplicar M3 (sin la tabla del organizador): aprobar funciona y no se llama a Google.
  state.missingTables = ["calendar_organizer", "user_google_calendar_event_map"];
  state.tables.profiles.push(student({ id: "a0000000-0000-4000-8000-00000000000a", email: "previo@umsa.bo" }, C1, "pending"));
  const early = await approveAs({ id: "a0000000-0000-4000-8000-00000000000a" }, "approved");
  assert.equal(early.student.registration_status, "approved");
  assert.equal(early.calendar.status, "not_configured");
  state.missingTables = [];
  state.tables.profiles = state.tables.profiles.filter((p) => p.user_id !== "a0000000-0000-4000-8000-00000000000a");

  // Sin las variables de Google en el servidor.
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  assert.equal((await runCohortSync()).status, "not_configured");
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-de-prueba";

  // Sin cuenta organizadora: nada que enviar, nada falla.
  let report = await runCohortSync();
  assert.equal(report.status, "organizer_not_connected");
  assert.equal(gcal.calls.length + gcal.tokenRefreshes, 0);

  // Se conecta la cuenta organizadora (como lo dejaría /callback).
  const key = cipher.loadCalendarTokenKey({ CALENDAR_TOKEN_ENCRYPTION_KEY: KEY });
  assert.ok(key.ok);
  state.tables.calendar_organizer.push({
    id: true,
    google_email: ORGANIZER,
    calendar_id: "primary",
    refresh_token_ciphertext: cipher.encryptRefreshToken(key.key, REFRESH_TOKEN),
    status: "connected",
    connected_at: nextTimestamp(),
    last_synced_at: null,
    last_error: null,
    last_error_at: null,
  });

  // Primera sincronización de la cohorte: aprobados con acceso × eventos futuros habilitados.
  report = await runCohortSync();
  assert.equal(report.status, "ok", JSON.stringify(report));
  assert.equal(report.created, 6, "BETO (autorizado) y LEGADO (heredado), 3 eventos cada uno");
  assert.equal(confirmedFor(BETO.email).length, 3);
  assert.equal(confirmedFor(LEGADO.email).length, 3);
  assert.equal(confirmedFor(CARLA.email).length, 0, "correo revocado: sin invitaciones");
  assert.equal(confirmedFor(ANA.email).length, 0, "pendiente: sin invitaciones");
  assert.equal(confirmedFor(TEACHER.email).length, 0);
  assert.equal(confirmedFor(DIEGO.email).length, 0, "otra cohorte");
  assert.ok(!gcal.calls.some((c) => c.id === content.invitationEventId(ORGANIZER, EV.initial, BETO.id)), "evento pasado: no se crea");
  assert.ok(!gcal.calls.some((c) => c.id === content.invitationEventId(ORGANIZER, EV.final, BETO.id)), "evento deshabilitado: no se crea");
  assert.ok(gcal.calls.every((c) => c.id && content.BASE32HEX_EVENT_ID.test(c.id)));
  assert.equal(mapRows().length, 6);
  assert.ok(mapRows().every((r) => r.status === "invited" && r.organizer_email === ORGANIZER && typeof r.content_hash === "string" && r.last_error === null));
  assert.equal(state.tables.calendar_organizer[0].last_error, null);
  assert.ok(state.tables.calendar_organizer[0].last_synced_at);

  // Repetir no llama a Google.
  let mark = gcal.calls.length;
  report = await runCohortSync();
  assert.deepEqual([report.status, report.created, report.updated, report.cancelled, report.unchanged], ["ok", 0, 0, 0, 6]);
  assert.equal(gcal.calls.length, mark, "sin cambios, sin llamadas");

  // Aprobar a ANA: la aprobación se guarda y recibe sus invitaciones.
  let result = await approveAs(ANA, "approved");
  assert.equal(result.student.registration_status, "approved");
  assert.deepEqual([result.calendar.status, result.calendar.created], ["ok", 3]);
  assert.equal(confirmedFor(ANA.email).length, 3);
  assert.equal((await approveAs(ANA, "approved")).calendar.created, 0, "aprobar dos veces no duplica");
  assert.equal(confirmedFor(ANA.email).length, 3);

  // Dos sincronizaciones a la vez: ni eventos ni registros duplicados.
  state.tables.profiles.push(student(EVA, C1, "approved"));
  const [r1, r2] = await Promise.all([runCohortSync(), runCohortSync()]);
  assert.equal(r1.status, "ok");
  assert.equal(r2.status, "ok");
  assert.equal(confirmedFor(EVA.email).length, 3);
  assert.equal(rowsOf(EVA).length, 3);
  assert.equal(new Set(mapRows().map((r) => `${String(r.user_id)}|${String(r.cohort_event_id)}`)).size, mapRows().length);
  assert.equal(gcal.events.size, 12, "4 estudiantes × 3 eventos, ninguno repetido");

  // Cambiar una fecha: el panel guarda (PUT) y sincroniza; solo se actualiza ese evento.
  const put = await cohortEvents.PUT(
    request("PUT", `/api/teacher/cohorts/${C1}/events`, { events: [{ event_kind: "ADVANCE", event_index: 1, event_date: day(15) }] }),
    cohortCtx(C1),
  );
  assert.equal(put.status, 200);
  mark = gcal.calls.length;
  report = await runCohortSync();
  assert.deepEqual([report.status, report.updated, report.created, report.cancelled], ["ok", 4, 0, 0], JSON.stringify(report));
  const dateCalls = callsSince(mark);
  assert.deepEqual([...new Set(dateCalls.map((c) => c.method))], ["PATCH"]);
  assert.ok(dateCalls.every((c) => (c.body?.start as Json).dateTime === `${day(15)}T09:30:00`));
  assert.deepEqual(gcal.events.get(content.invitationEventId(ORGANIZER, EV.advance1, ANA.id))?.body.start, { dateTime: `${day(15)}T09:30:00`, timeZone: TZ });
  assert.equal(gcal.events.size, 12, "cambiar la fecha no crea eventos nuevos");

  // Deshabilitar un evento: se cancela para todos.
  await cohortEvents.PUT(
    request("PUT", `/api/teacher/cohorts/${C1}/events`, { events: [{ event_kind: "FORM_MONTHLY", event_index: 2, event_date: day(40), is_enabled: false }] }),
    cohortCtx(C1),
  );
  mark = gcal.calls.length;
  report = await runCohortSync();
  assert.deepEqual([report.status, report.cancelled], ["ok", 4]);
  assert.ok(callsSince(mark).every((c) => c.method === "DELETE"));
  assert.ok(mapRows().filter((r) => r.cohort_event_id === EV.monthly2).every((r) => r.status === "cancelled"));

  // Rechazar a ANA: se guarda y se cancelan sus invitaciones futuras.
  result = await approveAs(ANA, "rejected");
  assert.equal(result.student.registration_status, "rejected");
  assert.deepEqual([result.calendar.status, result.calendar.cancelled], ["ok", 2]);
  assert.equal(confirmedFor(ANA.email).length, 0);
  assert.equal(state.tables.profiles.find((p) => p.user_id === ANA.id)?.registration_status, "rejected");

  // Revocar el Gmail de BETO: se cancelan sus invitaciones.
  const revoke = await emails.DELETE(request("DELETE", `/api/teacher/authorized-emails?email=${encodeURIComponent(BETO.email)}`));
  const revokeJson = (await revoke.json()) as { data: { calendar: Json } };
  assert.equal(revoke.status, 200);
  assert.deepEqual([revokeJson.data.calendar.status, revokeJson.data.calendar.cancelled], ["ok", 2]);
  assert.equal(confirmedFor(BETO.email).length, 0);

  // Volver a autorizarlo: recupera las mismas invitaciones (sin eventos nuevos).
  const sizeBefore = gcal.events.size;
  const reauth = await emails.POST(request("POST", "/api/teacher/authorized-emails", { email: BETO.email }));
  const reauthJson = (await reauth.json()) as { data: { calendar: Json } };
  assert.deepEqual([reauthJson.data.calendar.status, reauthJson.data.calendar.created], ["ok", 2]);
  assert.equal(confirmedFor(BETO.email).length, 2);
  assert.equal(gcal.events.size, sizeBefore, "se reactivan los mismos eventos");

  // Google cae: la aprobación se guarda igual; las invitaciones quedan pendientes con su error.
  state.tables.profiles.push(student(FRAN, C1, "pending"));
  gcal.failAlways = 503;
  result = await approveAs(FRAN, "approved");
  gcal.failAlways = 0;
  assert.equal(result.student.registration_status, "approved", "la aprobación no depende de Google");
  assert.equal(state.tables.profiles.find((p) => p.user_id === FRAN.id)?.registration_status, "approved");
  assert.deepEqual([result.calendar.status, result.calendar.failed], ["error", 2]);
  assert.equal(rowsOf(FRAN).length, 2);
  assert.ok(rowsOf(FRAN).every((r) => r.content_hash === null && String(r.last_error).includes("503")));
  assert.ok(String(state.tables.calendar_organizer[0].last_error).includes("no se pudieron sincronizar"));
  // Google vuelve; uno de los altas llega a Google pero la respuesta se pierde: sin duplicados.
  gcal.createThenFail = 1;
  const allRes = await organizerSync.POST(request("POST", "/api/teacher/calendar-organizer/sync"));
  report = ((await allRes.json()) as { data: { calendar: Json } }).data.calendar;
  assert.equal(report.status, "ok", JSON.stringify(report));
  assert.equal(confirmedFor(FRAN.email).length, 2);
  assert.ok(rowsOf(FRAN).every((r) => r.last_error === null && typeof r.content_hash === "string"));
  assert.equal(state.tables.calendar_organizer[0].last_error, null, "el error se limpia al sincronizar bien");

  // Cambio de cohorte de un aprobado (onboarding): queda pendiente y se cancelan sus invitaciones.
  state.user = LEGADO;
  clearStudentEmailAuthorizationCache();
  const resubmit = await onboarding.POST(
    request("POST", "/api/onboarding/submit", { ru: "7654321", first_name: "Leo", last_name: "Gado", semester: "1", company_name: "Empresa Secreta SRL", cohort_id: C2 }),
  );
  assert.equal(resubmit.status, 200);
  assert.equal(state.tables.profiles.find((p) => p.user_id === LEGADO.id)?.registration_status, "pending");
  assert.equal(confirmedFor(LEGADO.email).length, 0, "invitaciones de la cohorte anterior canceladas");
  state.user = TEACHER;

  // Acceso revocado en Google (invalid_grant): la aprobación se guarda; la conexión queda caída.
  state.tables.profiles.push(student(GABY, C1, "pending"));
  gcal.refresh = "invalid_grant";
  result = await approveAs(GABY, "approved");
  assert.equal(result.student.registration_status, "approved");
  assert.equal(result.calendar.status, "error");
  assert.ok(String(result.calendar.message).includes("Vuelve a conectarla"));
  assert.equal(state.tables.calendar_organizer[0].status, "disconnected");
  gcal.refresh = "ok";
  state.tables.calendar_organizer[0].status = "connected";

  // Límite de tiempo: lo que no alcanza queda pendiente y se informa.
  const partial = await sync.reconcileInvitations({ kind: "cohort", cohortId: C1 }, { origin: ORIGIN, budgetMs: 0 });
  assert.deepEqual([partial.status, partial.remaining], ["partial", 2], JSON.stringify(partial));
  assert.ok(String(state.tables.calendar_organizer[0].last_error).includes("pendientes"));
  report = await runCohortSync();
  assert.deepEqual([report.status, report.created], ["ok", 2]);

  // Invitaciones de otra cuenta organizadora: no se tocan.
  state.tables.user_google_calendar_event_map.push({
    id: "foreign-1",
    user_id: CARLA.id,
    cohort_event_id: EV.c2,
    calendar_id: "primary",
    google_event_id: "optiaotracuenta",
    status: "invited",
    organizer_email: "otra@gmail.com",
    content_hash: "x",
    last_error: null,
  });
  // Una invitación de un evento ya pasado.
  state.tables.user_google_calendar_event_map.push({
    id: "past-1",
    user_id: BETO.id,
    cohort_event_id: EV.initial,
    calendar_id: "primary",
    google_event_id: content.invitationEventId(ORGANIZER, EV.initial, BETO.id),
    status: "invited",
    organizer_email: ORGANIZER,
    content_hash: "x",
    last_error: null,
  });
  mark = gcal.calls.length;
  report = await runCohortSync();
  assert.equal(report.status, "ok");
  assert.equal(callsSince(mark).length, 0, "ni la invitación ajena ni la pasada se tocan al sincronizar");

  // Retirar todo: se cancelan las futuras; las pasadas solo se marcan; la ajena se informa.
  const confirmedBefore = [...gcal.events.values()].filter((e) => e.status === "confirmed").length;
  mark = gcal.calls.length;
  const wRes = await withdraw.POST(request("POST", "/api/teacher/calendar-organizer/withdraw"));
  report = ((await wRes.json()) as { data: { calendar: Json } }).data.calendar;
  assert.equal(report.status, "partial", "queda la invitación de otra cuenta");
  assert.equal(report.foreign, 1);
  assert.equal([...gcal.events.values()].filter((e) => e.status === "confirmed").length, 0);
  assert.equal(callsSince(mark).filter((c) => c.method === "DELETE").length, confirmedBefore, "un aviso por invitación futura");
  assert.ok(!callsSince(mark).some((c) => c.id === content.invitationEventId(ORGANIZER, EV.initial, BETO.id)), "sin aviso por la pasada");
  assert.equal(mapRows().find((r) => r.id === "past-1")?.status, "cancelled");
  assert.equal(mapRows().find((r) => r.id === "foreign-1")?.status, "invited");
  assert.ok(mapRows().filter((r) => r.organizer_email === ORGANIZER).every((r) => r.status === "cancelled"));

  // Permisos: solo docentes sincronizan o retiran.
  state.user = ANA;
  for (const call of [
    () => organizerSync.POST(request("POST", "/api/teacher/calendar-organizer/sync")),
    () => withdraw.POST(request("POST", "/api/teacher/calendar-organizer/withdraw")),
    () => cohortSync.POST(request("POST", `/api/teacher/cohorts/${C1}/calendar/sync`), cohortCtx(C1)),
    () => approve.POST(request("POST", "/api/teacher/students/approve", { user_id: ANA.id, status: "approved" })),
  ]) {
    assert.equal((await call()).status, 403);
  }
  state.user = TEACHER;

  // Nada privado ni secretos hacia Google, en la base o en los logs.
  for (const c of gcal.calls) {
    const text = JSON.stringify(c.body ?? {});
    for (const secret of PRIVATE) assert.ok(!text.includes(secret), `dato privado hacia Google: ${secret}`);
  }
  assert.ok(!JSON.stringify(state.tables.calendar_organizer).includes(REFRESH_TOKEN));
  assert.ok(!JSON.stringify(mapRows()).includes(ACCESS_TOKEN));
  for (const line of logs) {
    for (const secret of [REFRESH_TOKEN, ACCESS_TOKEN, KEY]) assert.ok(!line.includes(secret), `log con un secreto: ${line.slice(0, 120)}`);
  }

  stub.restore();
}

main()
  .then(() => process.stdout.write("calendarInvitations tests passed\n"))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
