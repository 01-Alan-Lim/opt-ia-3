import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { NextRequest } from "next/server";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, type RestStubState } from "./restStubHarness";

// Cuenta organizadora de Google Calendar: cifrado del refresh token (tokenCipher), OAuth
// (googleOAuth), CSRF, acceso solo docente y rutas /api/teacher/calendar-organizer. Supabase y
// Google simulados, sin red. Se comprueba que ningún token llega a respuestas, base en claro ni
// logs.

const TEACHER = { id: "10000000-0000-4000-8000-000000000001", email: "docente@gmail.com" };
const STUDENT = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const ORGANIZER = "optia.organizador@gmail.com";
const OTHER_ORGANIZER = "otra.cuenta@gmail.com";
const KEY = randomBytes(32).toString("base64");
const CLIENT_SECRET = "client-secret-de-prueba";
const ORIGIN = "https://opt-ia.test";

const state: RestStubState = {
  user: null,
  tables: { calendar_organizer: [], user_google_calendar_event_map: [] },
};

type Json = Record<string, unknown>;

// ---------------- Google simulado ----------------
let issued = 0;
const google = {
  revoked: [] as string[],
  tokenCalls: [] as URLSearchParams[],
  exchange: "ok" as "ok" | "fail" | "no_refresh" | "no_scope" | "unverified",
  email: ORGANIZER,
  refresh: "ok" as "ok" | "invalid_grant" | "down",
  lastRefreshToken: "",
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (email: string, verified = true) => `${b64({ alg: "RS256" })}.${b64({ email, email_verified: verified })}.firma`;
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function googleHandler(req: Request, url: URL): Promise<Response | null> {
  if (url.host !== "oauth2.googleapis.com") return null;
  const form = new URLSearchParams(await req.text());
  if (url.pathname === "/revoke") {
    google.revoked.push(form.get("token") ?? "");
    return new Response("", { status: 200 });
  }
  if (url.pathname !== "/token") return null;
  google.tokenCalls.push(form);
  assert.equal(form.get("client_secret"), CLIENT_SECRET, "el secreto solo viaja a Google");
  if (form.get("grant_type") === "authorization_code") {
    if (google.exchange === "fail") return jsonRes({ error: "invalid_grant" }, 400);
    google.lastRefreshToken = `1//refresh-token-secreto-${++issued}`;
    return jsonRes({
      access_token: `ya29.acceso-${issued}`,
      expires_in: 3599,
      refresh_token: google.exchange === "no_refresh" ? undefined : google.lastRefreshToken,
      scope: google.exchange === "no_scope" ? "openid email" : "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events",
      id_token: idToken(google.email, google.exchange !== "unverified"),
    });
  }
  if (google.refresh === "invalid_grant") return jsonRes({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
  if (google.refresh === "down") return jsonRes({ error: "backend_error" }, 503);
  return jsonRes({ access_token: "ya29.acceso-renovado", expires_in: 3599, scope: "https://www.googleapis.com/auth/calendar.events" });
}

// ---------------- Logs capturados ----------------
const logs: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    if (level === "error" || level === "warn") original(...args);
  };
}

function request(method: string, path: string, opts: { token?: string | null; body?: unknown; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? "token-de-prueba" : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    body: method === "POST" || method === "PUT" ? JSON.stringify(opts.body ?? {}) : undefined,
  });
}

async function main() {
  prepareRouteTestEnv({
    ALLOWED_EMAIL_DOMAIN: "umsa.bo",
    TEACHER_EMAIL_ALLOWLIST: TEACHER.email,
    CALENDAR_TOKEN_ENCRYPTION_KEY: KEY,
    NEXT_PUBLIC_CALENDAR_TOKEN_ENCRYPTION_KEY: undefined,
    GOOGLE_OAUTH_CLIENT_ID: "cliente.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  });
  const cipher = await import("../calendar/tokenCipher");
  const oauth = await import("../calendar/googleOAuth");
  const organizer = await import("../calendar/organizer");
  const statusRoute = await import("../../app/api/teacher/calendar-organizer/route");
  const startRoute = await import("../../app/api/teacher/calendar-organizer/start/route");
  const callbackRoute = await import("../../app/api/teacher/calendar-organizer/callback/route");
  const stub = installRestStub(state, googleHandler);

  // ---------------- Clave de cifrado ----------------
  const load = cipher.loadCalendarTokenKey;
  assert.deepEqual(load({}), { ok: false, reason: "MISSING" });
  assert.deepEqual(load({ CALENDAR_TOKEN_ENCRYPTION_KEY: "   " }), { ok: false, reason: "MISSING" });
  assert.deepEqual(load({ CALENDAR_TOKEN_ENCRYPTION_KEY: "no es base64!" }), { ok: false, reason: "INVALID_FORMAT" });
  assert.deepEqual(load({ CALENDAR_TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64") }), { ok: false, reason: "WRONG_LENGTH" });
  assert.deepEqual(load({ CALENDAR_TOKEN_ENCRYPTION_KEY: randomBytes(33).toString("base64") }), { ok: false, reason: "WRONG_LENGTH" });
  assert.deepEqual(
    load({ CALENDAR_TOKEN_ENCRYPTION_KEY: KEY, NEXT_PUBLIC_CALENDAR_TOKEN_ENCRYPTION_KEY: KEY }),
    { ok: false, reason: "EXPOSED_PUBLIC" },
    "una copia NEXT_PUBLIC_ acabaría en el navegador",
  );
  assert.equal(load({ CALENDAR_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url") }).ok, true, "admite base64url");
  const key = load({ CALENDAR_TOKEN_ENCRYPTION_KEY: KEY });
  const otherKey = load({ CALENDAR_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
  assert.ok(key.ok && otherKey.ok);
  assert.equal(JSON.stringify(key.key), "{}", "la clave no se serializa");

  // ---------------- Cifrado ----------------
  const secret = "1//refresh-token-de-prueba";
  const sealed = cipher.encryptRefreshToken(key.key, secret);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "formato que exige el check de M3");
  assert.ok(!sealed.includes(secret) && !sealed.includes(Buffer.from(secret).toString("base64url")));
  assert.notEqual(cipher.encryptRefreshToken(key.key, secret), sealed, "IV aleatorio");
  assert.equal(cipher.decryptRefreshToken(key.key, sealed), secret);
  assert.equal(cipher.decryptRefreshToken(otherKey.key, sealed), null, "otra clave: null");
  const parts = sealed.split(".");
  for (let i = 1; i < 4; i++) {
    const tampered = [...parts];
    const raw = Buffer.from(tampered[i], "base64url");
    raw[0] ^= 1;
    tampered[i] = raw.toString("base64url");
    assert.equal(cipher.decryptRefreshToken(key.key, tampered.join(".")), null, `parte ${i} manipulada: null`);
  }
  for (const bad of [null, 42, "", "v1", `v2.${parts.slice(1).join(".")}`, `${sealed}.x`, "v1.a.b.c", "v1.!!.!!.!!"]) {
    assert.equal(cipher.decryptRefreshToken(key.key, bad), null);
  }
  assert.throws(() => cipher.encryptRefreshToken(key.key, ""));

  // ---------------- OAuth: URL, state y canje ----------------
  const authUrl = new URL(oauth.buildOrganizerAuthUrl({ clientId: "cid", redirectUri: `${ORIGIN}/auth/calendar-callback`, state: "st" }));
  assert.equal(authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authUrl.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/calendar.events");
  assert.equal(authUrl.searchParams.get("access_type"), "offline");
  assert.equal(authUrl.searchParams.get("prompt"), "consent");
  assert.equal(authUrl.searchParams.get("redirect_uri"), `${ORIGIN}/auth/calendar-callback`);
  assert.equal(authUrl.searchParams.get("client_secret"), null);
  assert.deepEqual(oauth.decodeOrganizerState(oauth.encodeOrganizerState("c".repeat(32))), { csrf: "c".repeat(32) });
  assert.equal(oauth.decodeOrganizerState(b64({ rt: "/chat", csrf: "c".repeat(32) })), null, "state del flujo por estudiante: no vale");
  assert.equal(oauth.decodeOrganizerState(b64({ p: "organizer", csrf: "corto" })), null);
  assert.equal(oauth.decodeOrganizerState("%%%"), null);
  assert.equal(oauth.decodeOrganizerState("x".repeat(600)), null);

  // ---------------- Permisos ----------------
  const asUser = (user: { id: string; email: string } | null) => {
    state.user = user;
  };
  for (const [name, call] of [
    ["GET", () => statusRoute.GET(request("GET", "/api/teacher/calendar-organizer"))],
    ["DELETE", () => statusRoute.DELETE(request("DELETE", "/api/teacher/calendar-organizer"))],
    ["start", () => startRoute.POST(request("POST", "/api/teacher/calendar-organizer/start"))],
    ["callback", () => callbackRoute.POST(request("POST", "/api/teacher/calendar-organizer/callback", { body: { code: "x", state: "y" } }))],
  ] as const) {
    asUser(null);
    assert.equal((await call()).status, 401, `${name}: sin sesión`);
    asUser(STUDENT);
    assert.equal((await call()).status, 403, `${name}: un estudiante no gestiona el organizador`);
  }
  assert.equal(google.tokenCalls.length + google.revoked.length, 0, "sin llamadas a Google");
  assert.equal(stub.writes("calendar_organizer"), 0);

  // ---------------- Estado inicial ----------------
  asUser(TEACHER);
  const initial = (await (await statusRoute.GET(request("GET", "/api/teacher/calendar-organizer"))).json()) as Json;
  assert.deepEqual((initial.data as Json).configured, { oauth: true, encryptionKey: true });
  assert.equal((initial.data as Json).status, "not_connected");

  // ---------------- start ----------------
  async function start() {
    const res = await startRoute.POST(request("POST", "/api/teacher/calendar-organizer/start"));
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    const url = new URL(((await res.json()) as { data: { url: string } }).data.url);
    return { cookie, url, csrf: /gc_org_csrf=([^;]+)/.exec(cookie)?.[1] ?? "", state: url.searchParams.get("state") ?? "" };
  }
  const s1 = await start();
  assert.match(s1.cookie, /HttpOnly/i);
  assert.match(s1.cookie, /Secure/i);
  assert.match(s1.cookie, /SameSite=strict/i);
  assert.match(s1.cookie, /Path=\/api\/teacher\/calendar-organizer/);
  assert.match(s1.cookie, /Max-Age=600/);
  assert.ok(s1.csrf.length >= 32);
  assert.deepEqual(oauth.decodeOrganizerState(s1.state), { csrf: s1.csrf }, "el state lleva el mismo CSRF que la cookie");
  assert.equal(s1.url.searchParams.get("client_id"), "cliente.apps.googleusercontent.com");
  assert.equal(s1.url.searchParams.get("redirect_uri"), `${ORIGIN}/auth/calendar-callback`, "la URI de retorno ya registrada");
  assert.ok(!s1.url.toString().includes(CLIENT_SECRET));
  assert.notEqual((await start()).csrf, s1.csrf, "un CSRF nuevo cada vez");

  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const unconfigured = await startRoute.POST(request("POST", "/api/teacher/calendar-organizer/start"));
  assert.equal(unconfigured.status, 503);
  assert.equal(((await unconfigured.json()) as Json).code, "CALENDAR_NOT_CONFIGURED");
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;

  // ---------------- callback: CSRF ----------------
  const callback = (body: unknown, cookie?: string) =>
    callbackRoute.POST(request("POST", "/api/teacher/calendar-organizer/callback", { body, cookie }));
  const csrfCases: [string, unknown, string | undefined][] = [
    ["sin cookie", { code: "c", state: s1.state }, undefined],
    ["cookie de otro intento", { code: "c", state: s1.state }, `gc_org_csrf=${"z".repeat(32)}`],
    ["state ajeno", { code: "c", state: oauth.encodeOrganizerState("q".repeat(32)) }, `gc_org_csrf=${s1.csrf}`],
    ["state del flujo antiguo", { code: "c", state: b64({ rt: "/chat", csrf: s1.csrf }) }, `gc_org_csrf=${s1.csrf}`],
  ];
  for (const [name, body, cookie] of csrfCases) {
    const res = await callback(body, cookie);
    assert.equal(res.status, 403, `CSRF: ${name}`);
    assert.match(res.headers.get("set-cookie") ?? "", /gc_org_csrf=;.*Max-Age=0/, `${name}: se borra la cookie`);
  }
  assert.equal((await callback({ code: "c" }, `gc_org_csrf=${s1.csrf}`)).status, 400, "falta el state");
  assert.equal(google.tokenCalls.length, 0, "sin CSRF válido no se canjea nada");

  // Un estudiante con la cookie y el state de un docente tampoco.
  asUser(STUDENT);
  assert.equal((await callback({ code: "c", state: s1.state }, `gc_org_csrf=${s1.csrf}`)).status, 403);
  asUser(TEACHER);
  assert.equal(google.tokenCalls.length, 0);

  // ---------------- callback: errores de Google ----------------
  const valid = { code: "codigo-de-google", state: s1.state };
  const validCookie = `gc_org_csrf=${s1.csrf}`;
  for (const [mode, fragment] of [
    ["fail", "no aceptó"],
    ["no_scope", "permiso"],
    ["no_refresh", "acceso permanente"],
    ["unverified", "correo"],
  ] as const) {
    google.exchange = mode;
    const res = await callback(valid, validCookie);
    const body = (await res.json()) as Json;
    assert.equal(res.status, 400, mode);
    assert.equal(body.code, "GOOGLE_ERROR");
    assert.ok(String(body.message).includes(fragment), `${mode}: ${String(body.message)}`);
  }
  assert.equal(state.tables.calendar_organizer.length, 0, "nada guardado si Google falla");
  google.exchange = "ok";

  // ---------------- callback: conexión ----------------
  const connected = await callback(valid, validCookie);
  const connectedText = await connected.text();
  assert.equal(connected.status, 200, connectedText);
  assert.deepEqual(JSON.parse(connectedText), { ok: true, data: { googleEmail: ORGANIZER } });
  assert.match(connected.headers.get("set-cookie") ?? "", /Max-Age=0/, "la cookie CSRF es de un solo uso");
  const firstToken = google.lastRefreshToken;
  const codeCall = google.tokenCalls.at(-1);
  assert.equal(codeCall?.get("redirect_uri"), `${ORIGIN}/auth/calendar-callback`);
  assert.equal(codeCall?.get("code"), "codigo-de-google");

  const row = state.tables.calendar_organizer[0];
  assert.equal(state.tables.calendar_organizer.length, 1);
  assert.equal(row.google_email, ORGANIZER);
  assert.equal(row.status, "connected");
  assert.equal(row.connected_by, TEACHER.id);
  assert.equal(row.calendar_id, "primary");
  assert.ok(!JSON.stringify(row).includes(firstToken), "la base no guarda el token en claro");
  assert.equal(cipher.decryptRefreshToken(key.key, row.refresh_token_ciphertext), firstToken, "cifrado con CALENDAR_TOKEN_ENCRYPTION_KEY");

  // Estado: sin token ni texto cifrado.
  const status = await (await statusRoute.GET(request("GET", "/api/teacher/calendar-organizer"))).text();
  assert.ok(!status.includes(firstToken) && !status.includes(String(row.refresh_token_ciphertext)));
  assert.ok(!/refresh|ciphertext|access_token/i.test(status), status);
  assert.equal((JSON.parse(status) as { data: Json }).data.googleEmail, ORGANIZER);
  assert.equal((JSON.parse(status) as { data: Json }).data.status, "connected");

  // ---------------- Reconectar ----------------
  // Misma cuenta: se guarda el token nuevo y se revoca el anterior.
  const s2 = await start();
  assert.equal((await callback({ code: "otro-codigo", state: s2.state }, `gc_org_csrf=${s2.csrf}`)).status, 200);
  const secondToken = google.lastRefreshToken;
  assert.deepEqual(google.revoked, [firstToken]);
  assert.equal(cipher.decryptRefreshToken(key.key, state.tables.calendar_organizer[0].refresh_token_ciphertext), secondToken);

  // Otra cuenta con invitaciones enviadas por la actual: se rechaza y el token nuevo se revoca.
  state.tables.user_google_calendar_event_map.push({
    id: "m1",
    user_id: STUDENT.id,
    cohort_event_id: "e1",
    google_event_id: "optiaabc",
    status: "invited",
    organizer_email: ORGANIZER,
  });
  google.email = OTHER_ORGANIZER;
  const s3 = await start();
  const switched = await callback({ code: "codigo-otra", state: s3.state }, `gc_org_csrf=${s3.csrf}`);
  assert.equal(switched.status, 409);
  assert.ok(String(((await switched.json()) as Json).message).includes(ORGANIZER));
  assert.equal(google.revoked.at(-1), google.lastRefreshToken, "el token de la otra cuenta no se guarda");
  assert.equal(state.tables.calendar_organizer[0].google_email, ORGANIZER);
  assert.equal(cipher.decryptRefreshToken(key.key, state.tables.calendar_organizer[0].refresh_token_ciphertext), secondToken);

  // Si esas invitaciones ya se cancelaron, sí se puede cambiar de cuenta.
  state.tables.user_google_calendar_event_map[0].status = "cancelled";
  const s4 = await start();
  assert.equal((await callback({ code: "codigo-otra-2", state: s4.state }, `gc_org_csrf=${s4.csrf}`)).status, 200);
  assert.equal(state.tables.calendar_organizer[0].google_email, OTHER_ORGANIZER);
  assert.equal(state.tables.calendar_organizer.length, 1, "una sola fila");
  assert.ok(google.revoked.includes(secondToken), "el token de la cuenta anterior se revoca");
  const currentToken = google.lastRefreshToken;
  google.email = ORGANIZER;

  // ---------------- Token de acceso para Calendar ----------------
  const access = await organizer.getOrganizerAccess();
  assert.deepEqual(access, { ok: true, accessToken: "ya29.acceso-renovado", calendarId: "primary", googleEmail: OTHER_ORGANIZER });
  assert.equal(google.tokenCalls.at(-1)?.get("refresh_token"), currentToken);

  google.refresh = "down";
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "GOOGLE_UNAVAILABLE" });
  assert.equal(state.tables.calendar_organizer[0].status, "connected", "un fallo pasajero no desconecta");

  google.refresh = "invalid_grant";
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "REVOKED" });
  assert.equal(state.tables.calendar_organizer[0].status, "disconnected");
  assert.equal(state.tables.calendar_organizer[0].last_error, organizer.ORGANIZER_ERRORS.revoked);
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "NOT_CONNECTED" });
  const revokedStatus = (await (await statusRoute.GET(request("GET", "/api/teacher/calendar-organizer"))).json()) as { data: Json };
  assert.equal(revokedStatus.data.status, "disconnected");
  assert.equal(revokedStatus.data.lastError, organizer.ORGANIZER_ERRORS.revoked);
  google.refresh = "ok";

  // Texto cifrado con otra clave (p. ej. se cambió la variable): no se usa y se pide reconectar.
  state.tables.calendar_organizer[0].status = "connected";
  state.tables.calendar_organizer[0].refresh_token_ciphertext = cipher.encryptRefreshToken(otherKey.key, currentToken);
  const callsBefore = google.tokenCalls.length;
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "TOKEN_UNREADABLE" });
  assert.equal(google.tokenCalls.length, callsBefore, "sin token legible no se llama a Google");
  assert.equal(state.tables.calendar_organizer[0].last_error, organizer.ORGANIZER_ERRORS.unreadable);

  // Sin la tabla (M3 sin aplicar).
  state.missingTables = ["calendar_organizer"];
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "UNAVAILABLE" });
  assert.equal(((await (await statusRoute.GET(request("GET", "/api/teacher/calendar-organizer"))).json()) as { data: Json }).data.available, false);
  state.missingTables = [];

  // ---------------- Desconectar ----------------
  state.tables.calendar_organizer[0].refresh_token_ciphertext = cipher.encryptRefreshToken(key.key, currentToken);
  const disconnected = await statusRoute.DELETE(request("DELETE", "/api/teacher/calendar-organizer"));
  assert.equal(disconnected.status, 200);
  assert.deepEqual(((await disconnected.json()) as Json).data, { disconnected: true, revokedAtGoogle: true });
  assert.equal(google.revoked.at(-1), currentToken);
  assert.equal(state.tables.calendar_organizer.length, 0);
  assert.deepEqual(await organizer.getOrganizerAccess(), { ok: false, reason: "NOT_CONNECTED" });

  // ---------------- Ningún token en logs ----------------
  const allTokens = [firstToken, secondToken, currentToken, "ya29.acceso-renovado", CLIENT_SECRET, KEY];
  for (const line of logs) {
    for (const t of allTokens) assert.ok(!line.includes(t), `log con un secreto: ${line.slice(0, 120)}`);
  }

  stub.restore();
}

main()
  .then(() => process.stdout.write("calendarOrganizer tests passed\n"))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
