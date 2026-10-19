// Prueba de M3 (20261019005428_student_email_authorizations_calendar_organizer) en un Postgres en
// memoria (PGlite). No toca ninguna base real.
//
// Uso: node supabase/tests/m3_authorizations_calendar.pglite.mjs <carpeta-con-node_modules/@electric-sql/pglite>
// PGlite no es dependencia del proyecto: se instala aparte y se pasa su ruta.
//
// Replica de producción lo que M3 toca: profiles, cohorts, cohort_events,
// user_google_calendar_tokens y user_google_calendar_event_map (columnas, constraints, RLS y
// grants), auth.users y los privilegios por defecto que Supabase da a las tablas nuevas.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [envDir] = process.argv.slice(2);
if (!envDir) {
  console.error("Falta la carpeta donde está instalado @electric-sql/pglite.");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { PGlite } = await import(pathToFileURL(path.join(envDir, "node_modules", "@electric-sql", "pglite", "dist", "index.js")).href);

const MIGRATION = "20261019005428_student_email_authorizations_calendar_organizer.sql";
const MANUAL = "20261018230000";
const migration = readFileSync(path.join(root, "supabase", "migrations", MIGRATION), "utf8");
const verify = readFileSync(path.join(root, "supabase", "manual", `${MANUAL}_m3_verify.sql`), "utf8");
const rollback = readFileSync(path.join(root, "supabase", "manual", `${MANUAL}_m3_rollback.sql`), "utf8");

const db = new PGlite();
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const code = async (sql, params) => {
  try {
    if (params) await db.query(sql, params);
    else await db.exec(sql);
    return "ok";
  } catch (e) {
    return e.code || e.message;
  }
};
async function asRole(role, sql) {
  await db.exec(`set role ${role};`);
  try {
    await db.exec(sql);
    return "ok";
  } catch (e) {
    return e.code || e.message;
  } finally {
    await db.exec("reset role;");
  }
}
const fingerprint = async () =>
  JSON.stringify({
    tables: await q(`select table_name from information_schema.tables where table_schema = 'public' order by 1`),
    cols: await q(`select table_name, column_name, data_type, column_default from information_schema.columns where table_schema = 'public' order by 1, 2`),
    cons: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    idx: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`),
    acl: await q(`select relname, relacl::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`),
  });

// ---------------- Esquema como en producción ----------------
console.log("server_version:", (await q("show server_version"))[0].server_version);
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase concede todo a las tablas nuevas de public por defecto.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

  create table public.cohorts (id uuid primary key default gen_random_uuid(), name text not null, is_active boolean not null default true);
  create table public.profiles (
    id uuid primary key default gen_random_uuid(),
    user_id text not null unique,
    email text,
    role text default 'student',
    registration_status text default 'pending' check (registration_status in ('pending', 'approved', 'rejected')),
    cohort_id uuid references public.cohorts(id) on delete set null
  );
  create table public.cohort_events (
    id uuid primary key default gen_random_uuid(),
    cohort_id uuid not null references public.cohorts(id) on delete cascade,
    event_kind text not null, event_index smallint, event_key text not null, event_date date not null,
    is_enabled boolean not null default true
  );
  create table public.user_google_calendar_tokens (
    user_id uuid primary key references auth.users(id) on delete cascade,
    provider text not null default 'google', refresh_token text not null, calendar_id text not null default 'primary'
  );
  create table public.user_google_calendar_event_map (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    cohort_event_id uuid not null references public.cohort_events(id) on delete cascade,
    calendar_id text not null default 'primary',
    google_event_id text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_google_calendar_event_map_user_event_unique unique (user_id, cohort_event_id)
  );
  alter table public.user_google_calendar_event_map enable row level security;
  create policy ugcem_insert_own on public.user_google_calendar_event_map for insert to authenticated with check (auth.uid() = user_id);
  create policy ugcem_select_own on public.user_google_calendar_event_map for select to authenticated using (auth.uid() = user_id);
  alter table public.user_google_calendar_tokens enable row level security;
  create policy ugct_insert_own on public.user_google_calendar_tokens for insert to authenticated with check (auth.uid() = user_id);
`);

const ids = {
  umsa: "00000000-0000-4000-8000-000000000001",
  gmailApproved: "00000000-0000-4000-8000-000000000002",
  gmailPending: "00000000-0000-4000-8000-000000000003",
  gmailRejected: "00000000-0000-4000-8000-000000000004",
  teacher: "00000000-0000-4000-8000-000000000005",
  noEmail: "00000000-0000-4000-8000-000000000006",
  gmailMixedCase: "00000000-0000-4000-8000-000000000007",
};
for (const id of Object.values(ids)) await q(`insert into auth.users (id) values ($1)`, [id]);
const [{ id: COHORT }] = await q(`insert into public.cohorts (name) values ('2026-II') returning id`);
await db.exec(`
  insert into public.profiles (user_id, email, role, registration_status, cohort_id) values
    ('${ids.umsa}', 'ana@umsa.bo', 'student', 'approved', '${COHORT}'),
    ('${ids.gmailApproved}', 'beto@gmail.com', 'student', 'approved', '${COHORT}'),
    ('${ids.gmailPending}', 'caro@gmail.com', 'student', 'pending', '${COHORT}'),
    ('${ids.gmailRejected}', 'dani@gmail.com', 'student', 'rejected', '${COHORT}'),
    ('${ids.teacher}', 'docente@gmail.com', 'teacher', 'approved', null),
    ('${ids.noEmail}', null, 'student', 'approved', '${COHORT}'),
    ('${ids.gmailMixedCase}', '  Eva.Mixta@Gmail.com ', 'student', 'approved', '${COHORT}');
`);
const [{ id: EVENT }] = await q(`insert into public.cohort_events (cohort_id, event_kind, event_key, event_date) values ($1, 'FORM_INITIAL', 'FORM_INITIAL:_', '2026-11-05') returning id`, [COHORT]);
await db.exec(`grant all on all tables in schema public to anon, authenticated, service_role;`);
const profilesBefore = JSON.stringify(await q(`select * from public.profiles order by user_id`));

check("antes: authenticated puede escribir en el mapeo (estado actual)", await (async () => (await q(`select has_table_privilege('authenticated', 'public.user_google_calendar_event_map', 'INSERT') as v`))[0].v)());

// ---------------- Aplicar M3 ----------------
const applied = await code(migration);
check("M3 se aplica sin error", applied === "ok", applied);
const schemaAfter = await fingerprint();

// Transición.
const active = (await q(`select email from public.student_email_authorizations where revoked_at is null order by email`)).map((r) => r.email);
check("heredados: Gmail aprobados y pendientes, normalizados", JSON.stringify(active) === JSON.stringify(["beto@gmail.com", "caro@gmail.com", "eva.mixta@gmail.com"]), JSON.stringify(active));
check("heredados: sin rechazados, sin docentes, sin institucionales", !active.includes("dani@gmail.com") && !active.includes("docente@gmail.com") && !active.some((e) => e.endsWith("@umsa.bo")));
check("profiles intacto", JSON.stringify(await q(`select * from public.profiles order by user_id`)) === profilesBefore);

// verify.sql
const verifyRows = (await db.exec(verify)).flatMap((r) => r.rows);
const schemaChecks = verifyRows.filter((r) => "item" in r);
check("verify.sql: 18 comprobaciones", schemaChecks.length === 18, String(schemaChecks.length));
check("verify.sql: todas ok", schemaChecks.every((r) => r.ok === true), JSON.stringify(schemaChecks.filter((r) => r.ok !== true)));
const transition = verifyRows.find((r) => "active_authorizations" in r);
check("verify.sql: activas = estudiantes heredados", Number(transition.active_authorizations) === Number(transition.legacy_students), JSON.stringify(transition));

// Permisos.
check("authenticated no lee autorizaciones -> 42501", (await asRole("authenticated", `select * from public.student_email_authorizations;`)) === "42501");
check("authenticated no escribe autorizaciones -> 42501", (await asRole("authenticated", `insert into public.student_email_authorizations (email) values ('x@gmail.com');`)) === "42501");
check("anon no lee el organizador -> 42501", (await asRole("anon", `select * from public.calendar_organizer;`)) === "42501");
check("authenticated no lee el organizador -> 42501", (await asRole("authenticated", `select * from public.calendar_organizer;`)) === "42501");
check("authenticated ya no escribe el mapeo -> 42501",
  (await asRole("authenticated", `insert into public.user_google_calendar_event_map (user_id, cohort_event_id, google_event_id) values ('${ids.umsa}', '${EVENT}', 'x');`)) === "42501");
check("authenticated ya no escribe tokens -> 42501",
  (await asRole("authenticated", `insert into public.user_google_calendar_tokens (user_id, refresh_token) values ('${ids.umsa}', 'x');`)) === "42501");
check("service_role escribe autorizaciones", (await asRole("service_role", `insert into public.student_email_authorizations (email) values ('nuevo@gmail.com');`)) === "ok");

// Reglas de autorizaciones.
const ins = (email, extra = "") => code(`insert into public.student_email_authorizations (email${extra ? ", revoked_at" : ""}) values ($1${extra ? ", now()" : ""})`, [email]);
check("una sola activa por correo -> 23505", (await ins("beto@gmail.com")) === "23505");
check("correo sin normalizar -> 23514", (await ins("Mayus@Gmail.com")) === "23514");
check("correo inválido -> 23514", (await ins("no-es-correo")) === "23514");
check("revoked_by sin revoked_at -> 23514",
  (await code(`insert into public.student_email_authorizations (email, revoked_by) values ('z@gmail.com', '${ids.teacher}')`)) === "23514");
await q(`update public.student_email_authorizations set revoked_at = now(), revoked_by = $1 where email = 'beto@gmail.com' and revoked_at is null`, [ids.teacher]);
check("tras revocar, se puede volver a autorizar", (await ins("beto@gmail.com")) === "ok");
check("historial: una revocada y una activa",
  (await q(`select count(*) filter (where revoked_at is null)::int as a, count(*) filter (where revoked_at is not null)::int as r from public.student_email_authorizations where email = 'beto@gmail.com'`))[0].a === 1);

// Organizador.
const CIPHER = "v1.aXZpdml2aXZpdml2.Y2lwaGVydGV4dA.dGFndGFndGFndGFn";
check("organizador válido", (await code(`insert into public.calendar_organizer (google_email, refresh_token_ciphertext) values ('org@gmail.com', '${CIPHER}')`)) === "ok");
check("una sola fila -> 23505", (await code(`insert into public.calendar_organizer (google_email, refresh_token_ciphertext) values ('otro@gmail.com', '${CIPHER}')`)) === "23505");
check("id distinto de true -> 23514", (await code(`insert into public.calendar_organizer (id, google_email, refresh_token_ciphertext) values (false, 'o@gmail.com', '${CIPHER}')`)) === "23514");
check("token en claro -> 23514", (await code(`update public.calendar_organizer set refresh_token_ciphertext = '1//refresh-token-en-claro'`)) === "23514");
check("estado inválido -> 23514", (await code(`update public.calendar_organizer set status = 'raro'`)) === "23514");

// Mapeo de invitaciones.
await q(`insert into public.user_google_calendar_event_map (user_id, cohort_event_id, google_event_id, calendar_id) values ($1, $2, 'optiaabc123', 'primary')`, [ids.umsa, EVENT]);
check("status por defecto: invited", (await q(`select status from public.user_google_calendar_event_map`))[0].status === "invited");
check("status inválido -> 23514", (await code(`update public.user_google_calendar_event_map set status = 'enviado'`)) === "23514");
check("organizer_email normalizado", (await code(`update public.user_google_calendar_event_map set organizer_email = 'Org@Gmail.com'`)) === "23514");
check("organizer_email válido", (await code(`update public.user_google_calendar_event_map set organizer_email = 'org@gmail.com'`)) === "ok");
check("una invitación por estudiante y evento -> 23505",
  (await code(`insert into public.user_google_calendar_event_map (user_id, cohort_event_id, google_event_id) values ('${ids.umsa}', '${EVENT}', 'otro')`)) === "23505");

// Idempotencia.
const authCount = (await q(`select count(*)::int as n from public.student_email_authorizations`))[0].n;
check("M3 se puede reaplicar", (await code(migration)) === "ok");
check("reaplicar no duplica heredados", (await q(`select count(*)::int as n from public.student_email_authorizations`))[0].n === authCount);
check("reaplicar no cambia el esquema", (await fingerprint()) === schemaAfter);

// Rollback y reaplicación.
check("rollback se aplica", (await code(rollback)) === "ok");
check("rollback: tablas nuevas retiradas",
  (await q(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('student_email_authorizations', 'calendar_organizer')`))[0].n === 0);
check("rollback: columnas retiradas del mapeo",
  (await q(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'user_google_calendar_event_map' and column_name in ('status', 'organizer_email', 'content_hash', 'last_synced_at', 'last_error')`))[0].n === 0);
check("rollback: authenticated vuelve a poder escribir el mapeo",
  (await q(`select has_table_privilege('authenticated', 'public.user_google_calendar_event_map', 'INSERT') as v`))[0].v === true);
check("rollback: profiles intacto", JSON.stringify(await q(`select * from public.profiles order by user_id`)) === profilesBefore);
check("re-aplicar tras rollback", (await code(migration)) === "ok");

console.log(`\nRESULT: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
await db.close();
process.exit(failures === 0 ? 0 : 1);
