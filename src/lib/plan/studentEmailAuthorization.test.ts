import assert from "node:assert/strict";

import { prepareRouteTestEnv, routeRequest } from "./assistantRouteHarness";
import { installRestStub, nextTimestamp, type RestStubState } from "./restStubHarness";

// Acceso de estudiantes por correo (src/lib/auth/studentEmailAuthorization.ts, requireUser) y la
// API docente de correos autorizados (/api/teacher/authorized-emails). Sin red: Supabase
// simulado con la tabla de M3 y su índice único parcial.

const TEACHER = { id: "10000000-0000-4000-8000-000000000001", email: "docente@gmail.com" };
const UMSA = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const GMAIL = { id: "30000000-0000-4000-8000-000000000003", email: "beto@gmail.com" };
const LEGACY = { id: "40000000-0000-4000-8000-000000000004", email: "legado@gmail.com" };
const REVOKED_LEGACY = { id: "50000000-0000-4000-8000-000000000005", email: "revocado@gmail.com" };
const STRANGER = { id: "60000000-0000-4000-8000-000000000006", email: "otro@gmail.com" };

const state: RestStubState = {
  user: null,
  tables: {
    student_email_authorizations: [
      { id: "a1", email: "beto@gmail.com", note: null, authorized_by: TEACHER.id, created_at: "2026-10-01T10:00:00Z", revoked_at: null, revoked_by: null },
      { id: "a2", email: "revocado@gmail.com", note: null, authorized_by: TEACHER.id, created_at: "2026-10-01T10:00:00Z", revoked_at: "2026-10-02T10:00:00Z", revoked_by: TEACHER.id },
    ],
    profiles: [
      { user_id: GMAIL.id, email: GMAIL.email, role: "student", registration_status: "approved" },
      { user_id: LEGACY.id, email: LEGACY.email, role: "student", registration_status: "pending" },
    ],
  },
  uniques: {
    student_email_authorizations: [
      { name: "student_email_authorizations_active_email_key", columns: ["email"], where: (r) => r.revoked_at === null || r.revoked_at === undefined },
    ],
  },
  defaults: {
    student_email_authorizations: () => ({ id: crypto.randomUUID(), note: null, created_at: nextTimestamp(), revoked_at: null, revoked_by: null }),
  },
};

type Json = Record<string, unknown>;

async function main() {
  prepareRouteTestEnv({
    ALLOWED_EMAIL_DOMAIN: "umsa.bo",
    TEACHER_EMAIL_ALLOWLIST: TEACHER.email,
    STUDENT_TEST_EMAIL_ALLOWLIST: `${LEGACY.email}, ${REVOKED_LEGACY.email}`,
  });
  const lib = await import("../auth/studentEmailAuthorization");
  const { requireUser, getAuthErrorCode } = await import("../auth/supabase");
  const route = await import("../../app/api/teacher/authorized-emails/route");
  const stub = installRestStub(state);

  // ---------------- Decisión (pura) ----------------
  const d = lib.decideStudentAccess;
  assert.deepEqual(d({ institutional: true, lookup: "revoked", envAllowlisted: false }), { allowed: true, via: "institutional" });
  assert.deepEqual(d({ institutional: false, lookup: "active", envAllowlisted: false }), { allowed: true, via: "authorized" });
  assert.deepEqual(d({ institutional: false, lookup: "revoked", envAllowlisted: true }), { allowed: false, via: "revoked" }, "la revocación prevalece");
  assert.deepEqual(d({ institutional: false, lookup: "none", envAllowlisted: true }), { allowed: true, via: "legacy_env" });
  assert.deepEqual(d({ institutional: false, lookup: "unavailable", envAllowlisted: true }), { allowed: true, via: "legacy_env" });
  assert.deepEqual(d({ institutional: false, lookup: "none", envAllowlisted: false }), { allowed: false, via: "not_authorized" });
  assert.equal(lib.normalizeEmail("  Ana.Perez@UMSA.bo "), "ana.perez@umsa.bo");
  assert.equal(lib.isInstitutionalEmail("ana@umsa.bo", "umsa.bo"), true);
  assert.equal(lib.isInstitutionalEmail("ana@umsa.bo.evil.com", "umsa.bo"), false);
  assert.equal(lib.isInstitutionalEmail("ana@fakeumsa.bo", "umsa.bo"), false);
  assert.equal(lib.isInstitutionalEmail("cualquiera@gmail.com", null), true, "sin dominio configurado no hay restricción");

  // ---------------- requireUser ----------------
  async function as(user: { id: string; email: string } | null) {
    state.user = user;
    lib.clearStudentEmailAuthorizationCache();
    stub.reset();
    try {
      const authed = await requireUser(routeRequest("/api/x", {}));
      return { role: authed.role, lookups: stub.calls.filter((c) => c.table === "student_email_authorizations").length };
    } catch (err: unknown) {
      return { error: getAuthErrorCode(err), lookups: stub.calls.filter((c) => c.table === "student_email_authorizations").length };
    }
  }
  assert.deepEqual(await as(UMSA), { role: "student", lookups: 0 }, "institucional: sin consulta");
  assert.deepEqual(await as(TEACHER), { role: "teacher", lookups: 0 }, "docente: sin consulta");
  assert.deepEqual(await as(GMAIL), { role: "student", lookups: 1 }, "Gmail autorizado");
  assert.deepEqual(await as(LEGACY), { role: "student", lookups: 1 }, "heredado del entorno, sin filas");
  assert.deepEqual(await as(REVOKED_LEGACY), { error: "FORBIDDEN_DOMAIN", lookups: 1 }, "revocado aunque esté en el entorno");
  assert.deepEqual(await as(STRANGER), { error: "FORBIDDEN_DOMAIN", lookups: 1 });
  assert.deepEqual(await as(null), { error: "UNAUTHORIZED", lookups: 0 });

  // Caché de 30 s: una consulta para varias peticiones; se invalida al autorizar o revocar.
  state.user = GMAIL;
  lib.clearStudentEmailAuthorizationCache();
  stub.reset();
  await requireUser(routeRequest("/api/x", {}));
  await requireUser(routeRequest("/api/x", {}));
  assert.equal(stub.calls.filter((c) => c.table === "student_email_authorizations").length, 1);

  // Sin M3 aplicada: vale solo la lista heredada; nadie heredado queda fuera.
  state.missingTables = ["student_email_authorizations"];
  assert.deepEqual(await as(LEGACY), { role: "student", lookups: 1 });
  assert.deepEqual(await as(REVOKED_LEGACY), { role: "student", lookups: 1 }, "sin la tabla no hay revocaciones que aplicar");
  assert.deepEqual(await as(GMAIL), { error: "FORBIDDEN_DOMAIN", lookups: 1 });
  state.missingTables = [];

  // Otro error de la base: falla cerrado.
  state.failTables = { student_email_authorizations: { status: 500, code: "XX000", message: "boom" } };
  assert.deepEqual(await as(GMAIL), { error: "AUTH_UPSTREAM_ERROR", lookups: 1 });
  state.failTables = {};

  // ---------------- API docente ----------------
  async function call(method: "GET" | "POST" | "DELETE", user: { id: string; email: string } | null, opts: { body?: unknown; email?: string } = {}) {
    state.user = user;
    const path = `/api/teacher/authorized-emails${opts.email ? `?email=${encodeURIComponent(opts.email)}` : ""}`;
    const req = routeRequest(path, opts.body ?? {});
    const init = new Request(req.url, { method, headers: req.headers, body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined });
    const res = method === "GET" ? await route.GET(init) : method === "POST" ? await route.POST(init) : await route.DELETE(init);
    return { status: res.status, json: (await res.json()) as Json };
  }
  const authRows = () => state.tables.student_email_authorizations;

  // Permisos.
  for (const method of ["GET", "POST", "DELETE"] as const) {
    assert.equal((await call(method, null, { body: { email: "x@gmail.com" }, email: "x@gmail.com" })).status, 401);
    const student = await call(method, UMSA, { body: { email: "x@gmail.com" }, email: "x@gmail.com" });
    assert.equal(student.status, 403, `${method}: un estudiante no administra correos`);
  }
  assert.equal(authRows().length, 2, "ningún intento sin permiso escribió");

  // Autorizar.
  const created = await call("POST", TEACHER, { body: { email: "  Nuevo.Alumno@Gmail.com ", note: "Intercambio" } });
  assert.equal(created.status, 200);
  assert.equal((created.json.data as Json).created, true);
  const row = authRows().find((r) => r.email === "nuevo.alumno@gmail.com");
  assert.ok(row, "guardado normalizado");
  assert.equal(row?.authorized_by, TEACHER.id, "quién autoriza lo pone el servidor");
  assert.equal(row?.note, "Intercambio");
  const again = await call("POST", TEACHER, { body: { email: "nuevo.alumno@gmail.com" } });
  assert.equal(again.status, 200);
  assert.equal((again.json.data as Json).created, false, "idempotente");
  assert.equal(authRows().filter((r) => r.email === "nuevo.alumno@gmail.com" && r.revoked_at === null).length, 1);
  assert.equal((await call("POST", TEACHER, { body: { email: "ana@umsa.bo" } })).status, 400, "institucionales no se autorizan");
  assert.equal((await call("POST", TEACHER, { body: { email: "no-es-correo" } })).status, 400);
  assert.equal((await call("POST", TEACHER, { body: { email: "x@gmail.com", note: "x".repeat(201) } })).status, 400);

  // Entra, pero sin aprobación académica (eso lo decide /api/me con registration_status).
  assert.deepEqual(await as({ id: "70000000-0000-4000-8000-000000000007", email: "nuevo.alumno@gmail.com" }), { role: "student", lookups: 1 });

  // Lista con el estado académico del perfil.
  const list = await call("GET", TEACHER);
  assert.equal(list.status, 200);
  const items = (list.json.data as { items: Json[] }).items;
  const beto = items.find((i) => i.email === GMAIL.email);
  assert.equal(beto?.registrationStatus, "approved");
  assert.equal(beto?.active, true);
  assert.ok(items.every((i) => !("authorized_by" in i) && !("revoked_by" in i)), "sin identificadores internos");

  // Revocar una activa: deja de entrar (la caché se invalida).
  const revoke = await call("DELETE", TEACHER, { email: GMAIL.email });
  assert.equal(revoke.status, 200);
  assert.equal((revoke.json.data as Json).wasActive, true);
  assert.deepEqual(await as(GMAIL), { error: "FORBIDDEN_DOMAIN", lookups: 1 });

  // Revocar un acceso heredado del entorno: queda constancia y prevalece.
  const revokeLegacy = await call("DELETE", TEACHER, { email: LEGACY.email });
  assert.equal(revokeLegacy.status, 200);
  assert.equal((revokeLegacy.json.data as Json).wasActive, false);
  assert.ok(authRows().some((r) => r.email === LEGACY.email && r.revoked_at !== null && r.revoked_by === TEACHER.id));
  assert.deepEqual(await as(LEGACY), { error: "FORBIDDEN_DOMAIN", lookups: 1 }, "en el entorno, pero revocado");

  // Volver a autorizar tras revocar.
  assert.equal((await call("POST", TEACHER, { body: { email: GMAIL.email } })).status, 200);
  assert.deepEqual(await as(GMAIL), { role: "student", lookups: 1 });

  // Sin M3: la API lo dice, no inventa datos.
  state.missingTables = ["student_email_authorizations"];
  assert.equal((await call("GET", TEACHER)).status, 503);
  assert.equal((await call("POST", TEACHER, { body: { email: "y@gmail.com" } })).status, 503);
  state.missingTables = [];

  stub.restore();
}

main()
  .then(() => console.log("studentEmailAuthorization tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
