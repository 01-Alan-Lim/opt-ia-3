// Prueba de M2 (20261018160000_message_provenance_receipt_idempotency) en un Postgres en
// memoria (PGlite). No toca ninguna base real.
//
// Uso: node supabase/tests/m2_message_provenance.pglite.mjs <carpeta-con-node_modules/@electric-sql/pglite>
// PGlite no es dependencia del proyecto: se instala aparte (npm i @electric-sql/pglite en una
// carpeta temporal) y se pasa su ruta.
//
// Replica de producción lo que M2 toca: messages (columnas, CHECK de role, FK, RLS y grants
// tras M1), chats, profiles y las dos vistas que leen messages.role.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [envDir] = process.argv.slice(2);
if (!envDir) {
  console.error("Falta la carpeta donde está instalado @electric-sql/pglite.");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { PGlite } = await import(
  pathToFileURL(path.join(envDir, "node_modules", "@electric-sql", "pglite", "dist", "index.js")).href
);

const VERSION = "20261018160000";
const migration = readFileSync(path.join(root, "supabase", "migrations", `${VERSION}_message_provenance_receipt_idempotency.sql`), "utf8");
const verify = readFileSync(path.join(root, "supabase", "manual", `${VERSION}_m2_verify.sql`), "utf8");
const rollback = readFileSync(path.join(root, "supabase", "manual", `${VERSION}_m2_rollback.sql`), "utf8");

const db = new PGlite();
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
// Con parámetros, una sentencia (query); sin ellos, un script completo (exec).
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
const schemaFingerprint = async () =>
  JSON.stringify({
    cols: await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns
                   where table_schema = 'public' and table_name = 'messages' order by column_name`),
    cons: await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
                   where conrelid = 'public.messages'::regclass order by conname`),
    idx: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'messages' order by indexname`),
  });
const legacySnapshot = async () =>
  JSON.stringify(await q(`select id, chat_id, role, content, created_at from public.messages order by created_at, id`));
const viewsSnapshot = async () =>
  JSON.stringify({
    usage: await q(`select * from public.v_student_usage order by user_id`),
    daily: await q(`select * from public.v_bi_usage_daily order by student_id, day`),
  });

// ---------------- Esquema como en producción ----------------
console.log("server_version:", (await q("show server_version"))[0].server_version);
await db.exec(`
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role looker_reader nologin;
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

  create table public.chats (
    id uuid primary key default gen_random_uuid(),
    client_id text not null,
    title text,
    created_at timestamptz not null default now(),
    mode text default 'general',
    pinned boolean not null default false,
    hidden boolean not null default false
  );
  create table public.profiles (user_id text primary key, cohort_id uuid);
  create table public.messages (
    id uuid not null default gen_random_uuid(),
    chat_id uuid not null,
    role text not null,
    content text not null,
    created_at timestamptz not null default now(),
    constraint messages_pkey primary key (id),
    constraint messages_chat_fk foreign key (chat_id) references public.chats(id) on delete restrict,
    constraint messages_role_check check ((role = any (array['user'::text, 'assistant'::text, 'system'::text])))
  );
  alter table public.messages enable row level security;
  create policy messages_select_own_chat on public.messages for select to authenticated
    using (exists (select 1 from public.chats c where c.id = messages.chat_id and c.client_id = (auth.uid())::text));
  create policy messages_insert_own_chat on public.messages for insert to authenticated
    with check (exists (select 1 from public.chats c where c.id = messages.chat_id and c.client_id = (auth.uid())::text));
  grant select on public.messages to authenticated;
  grant all on public.messages to service_role;
  grant select on public.messages to looker_reader;

  create view public.v_student_usage as
   select c.client_id as user_id, count(*) as messages_total,
     count(*) filter (where m.role = 'user'::text) as messages_user,
     count(*) filter (where m.role = 'assistant'::text) as messages_assistant,
     min(m.created_at) as first_message_at, max(m.created_at) as last_message_at
   from messages m join chats c on c.id = m.chat_id group by c.client_id;
  create view public.v_bi_usage_daily as
   select c.client_id as student_id, p.cohort_id, date_trunc('day'::text, m.created_at)::date as day,
     count(*) as messages_total,
     count(*) filter (where m.role = 'user'::text) as messages_user,
     count(*) filter (where m.role = 'assistant'::text) as messages_assistant,
     max(m.created_at) as last_activity_at
   from messages m join chats c on c.id = m.chat_id left join profiles p on p.user_id = c.client_id
   group by c.client_id, p.cohort_id, (date_trunc('day'::text, m.created_at)::date);
`);

const STUDENT = "11111111-1111-4111-8111-111111111111";
const [{ id: ADVISOR_CHAT }] = await q(`insert into public.chats (client_id, mode) values ($1, 'plan_mejora') returning id`, [STUDENT]);
const [{ id: OTHER_CHAT }] = await q(`insert into public.chats (client_id, mode) values ($1, 'plan_mejora') returning id`, [STUDENT]);
const [{ id: GENERAL_CHAT }] = await q(`insert into public.chats (client_id, mode) values ($1, 'general') returning id`, [STUDENT]);
await q(`insert into public.profiles values ($1, gen_random_uuid())`, [STUDENT]);

// Histórico: user y assistant (reales y locales mezclados, como en producción).
await db.exec(`
  insert into public.messages (chat_id, role, content, created_at) values
    ('${ADVISOR_CHAT}', 'assistant', '¡Hola! Ya tengo tu Contexto del Caso registrado.', '2026-09-01T10:00:00Z'),
    ('${ADVISOR_CHAT}', 'user', 'Sí, empecemos', '2026-09-01T10:00:05Z'),
    ('${ADVISOR_CHAT}', 'assistant', 'Empecemos por la unidad de medida.', '2026-09-01T10:00:09Z'),
    ('${GENERAL_CHAT}', 'user', '¿Cómo registro mis horas?', '2026-09-02T09:00:00Z'),
    ('${GENERAL_CHAT}', 'assistant', 'Puedes registrarlas desde el formulario.', '2026-09-02T09:00:03Z');
`);
const legacyBefore = await legacySnapshot();
const viewsBefore = await viewsSnapshot();

// Antes de M2: el código nuevo no puede escribir (lo que el servidor traduce a SCHEMA_NOT_READY).
check("antes: advisor -> 23514", (await code(`insert into public.messages (chat_id, role, content) values ($1, 'advisor', 'x')`, [ADVISOR_CHAT])) === "23514");
check("antes: receipt_nonce no existe -> 42703",
  (await code(`insert into public.messages (chat_id, role, content, receipt_nonce) values ($1, 'assistant', 'x', 'abcdefghijklmnop')`, [ADVISOR_CHAT])) === "42703");

// ---------------- Aplicar M2 tal cual está en el archivo ----------------
const applied = await code(migration);
check("M2 se aplica sin error", applied === "ok", applied);
const schemaAfter = await schemaFingerprint();

check("histórico intacto (id, role, content, created_at)", (await legacySnapshot()) === legacyBefore);
check("histórico: columnas nuevas en NULL",
  (await q(`select count(*)::int as n from public.messages where receipt_nonce is not null or client_message_id is not null`))[0].n === 0);
check("vistas: mismo resultado tras aplicar", (await viewsSnapshot()) === viewsBefore);

const verifyRows = (await db.exec(verify)).flatMap((r) => r.rows);
const schemaChecks = verifyRows.filter((r) => "item" in r);
check("verify.sql: 7 comprobaciones de esquema", schemaChecks.length === 7, String(schemaChecks.length));
check("verify.sql: todas ok", schemaChecks.every((r) => r.ok === true), JSON.stringify(schemaChecks.filter((r) => r.ok !== true)));
check("verify.sql: authenticated sin escritura", verifyRows.filter((r) => "granted" in r).every((r) => r.granted === false));

// Roles.
check("advisor se acepta", (await code(`insert into public.messages (chat_id, role, content) values ($1, 'advisor', '✅ Ya tenemos suficientes causas.')`, [ADVISOR_CHAT])) === "ok");
check("system se rechaza -> 23514", (await code(`insert into public.messages (chat_id, role, content) values ($1, 'system', 'x')`, [ADVISOR_CHAT])) === "23514");
check("role arbitrario se rechaza -> 23514", (await code(`insert into public.messages (chat_id, role, content) values ($1, 'model', 'x')`, [ADVISOR_CHAT])) === "23514");

// Recibos: una fila por nonce, en toda la tabla.
const NONCE = "n0nce_de-prueba_0123456789";
const ins = (chat, role, nonce, clientId = null) =>
  code(`insert into public.messages (chat_id, role, content, receipt_nonce, client_message_id) values ($1, $2, 'texto', $3, $4)`, [chat, role, nonce, clientId]);
check("assistant con nonce se acepta", (await ins(ADVISOR_CHAT, "assistant", NONCE)) === "ok");
check("mismo nonce, mismo chat -> 23505", (await ins(ADVISOR_CHAT, "assistant", NONCE)) === "23505");
check("mismo nonce, otro chat -> 23505", (await ins(OTHER_CHAT, "assistant", NONCE)) === "23505");
check("nonce en user -> 23514", (await ins(ADVISOR_CHAT, "user", "otro_nonce_0123456789")) === "23514");
check("nonce en advisor -> 23514", (await ins(ADVISOR_CHAT, "advisor", "otro_nonce_0123456789")) === "23514");
check("nonce con formato inválido -> 23514", (await ins(ADVISOR_CHAT, "assistant", "corto")) === "23514");
check("nonce con caracteres inválidos -> 23514", (await ins(ADVISOR_CHAT, "assistant", "nonce con espacios 0123")) === "23514");
check("varias assistant sin nonce (servidor/histórico)", (await ins(ADVISOR_CHAT, "assistant", null)) === "ok" && (await ins(ADVISOR_CHAT, "assistant", null)) === "ok");

// Idempotencia de reintentos: única por chat.
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
check("client_message_id se acepta", (await ins(ADVISOR_CHAT, "user", null, CLIENT_ID)) === "ok");
check("mismo client_message_id, mismo chat -> 23505", (await ins(ADVISOR_CHAT, "advisor", null, CLIENT_ID)) === "23505");
check("mismo client_message_id, otro chat -> ok", (await ins(OTHER_CHAT, "user", null, CLIENT_ID)) === "ok");

// Una transacción que choca no deja nada a medias.
await db.exec("begin;");
const inTx = await code(`insert into public.messages (chat_id, role, content, receipt_nonce) values ($1, 'assistant', 'x', $2)`, [OTHER_CHAT, NONCE]);
await db.exec("rollback;");
check("conflicto dentro de transacción -> 23505", inTx === "23505");
check("una fila por nonce", (await q(`select count(*)::int as n from public.messages where receipt_nonce = $1`, [NONCE]))[0].n === 1);

// Vistas y orden.
const usage = (await q(`select * from public.v_student_usage where user_id = $1`, [STUDENT]))[0];
const totals = (await q(`select count(*)::int as all_rows, count(*) filter (where role = 'assistant')::int as assistant from public.messages`))[0];
check("vista: messages_total incluye advisor", Number(usage.messages_total) === totals.all_rows);
check("vista: messages_assistant no cuenta advisor", Number(usage.messages_assistant) === totals.assistant);
const ordered = await q(`select content from public.messages where chat_id = $1 order by created_at, id limit 3`, [ADVISOR_CHAT]);
check("orden: el histórico sigue primero", ordered[0].content.startsWith("¡Hola!") && ordered[1].content === "Sí, empecemos");

// Permisos: authenticated sigue sin escribir.
check("authenticated INSERT -> 42501",
  (await asRole("authenticated", `insert into public.messages (chat_id, role, content) values ('${ADVISOR_CHAT}', 'advisor', 'x');`)) === "42501");
check("service_role INSERT advisor -> ok",
  (await asRole("service_role", `insert into public.messages (chat_id, role, content) values ('${ADVISOR_CHAT}', 'advisor', 'x');`)) === "ok");

// Idempotencia de la propia migración.
check("M2 se puede reaplicar", (await code(migration)) === "ok");
check("reaplicar no cambia el esquema", (await schemaFingerprint()) === schemaAfter);

// Rollback: se niega con filas advisor y no toca nada.
const refused = await code(rollback);
await code("rollback;");
check("rollback se niega con filas advisor", refused !== "ok" && (await schemaFingerprint()) === schemaAfter, refused);

// Sin filas advisor (solo en esta prueba) el rollback restaura el esquema original.
await db.exec(`delete from public.messages where role = 'advisor'; delete from public.messages where receipt_nonce is not null or client_message_id is not null;`);
const rolled = await code(rollback);
check("rollback sin advisor se aplica", rolled === "ok", rolled);
const original = await q(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_role_check'`);
check("rollback: CHECK original", original[0].def === "CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))", original[0].def);
check("rollback: columnas retiradas",
  (await q(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name in ('receipt_nonce', 'client_message_id')`))[0].n === 0);
check("re-aplicar tras rollback", (await code(migration)) === "ok" && (await schemaFingerprint()) === schemaAfter);

console.log(`\nRESULT: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
await db.close();
process.exit(failures === 0 ? 0 : 1);
