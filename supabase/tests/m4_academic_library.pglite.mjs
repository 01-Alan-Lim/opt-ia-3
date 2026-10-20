// Prueba de M4 (20261020150000_academic_library_documents) en un Postgres en memoria (PGlite) con
// pgvector. No toca ninguna base real.
//
// Uso: node supabase/tests/m4_academic_library.pglite.mjs <carpeta-con-node_modules/@electric-sql/pglite>
// PGlite no es dependencia del proyecto: se instala aparte en una carpeta temporal y se pasa su
// ruta (npm i @electric-sql/pglite @electric-sql/pglite-pgvector). Desde PGlite 0.5 pgvector es el
// paquete @electric-sql/pglite-pgvector; en versiones anteriores venía dentro de PGlite (dist/vector).
//
// Replica de producción lo que M4 toca: documents y document_chunks (columnas, FK con cascada, RLS,
// policies y grants), las dos variantes de match_document_chunks, set_updated_at y las 10 guías en
// storage.objects. Los datos imitan los reales: 10 guías con 61 fragmentos y el demo con 3.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [envDir] = process.argv.slice(2);
if (!envDir) {
  console.error("Falta la carpeta donde está instalado @electric-sql/pglite.");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(envDir, "node_modules", "@electric-sql", "pglite", "dist");
const { PGlite } = await import(pathToFileURL(path.join(dist, "index.js")).href);
const vectorEntry = [
  path.join(envDir, "node_modules", "@electric-sql", "pglite-pgvector", "dist", "index.js"),
  path.join(dist, "vector", "index.js"),
].find((file) => existsSync(file));
if (!vectorEntry) {
  console.error("Falta pgvector para PGlite (@electric-sql/pglite-pgvector).");
  process.exit(2);
}
const { vector } = await import(pathToFileURL(vectorEntry).href);

// La migración lleva la versión local hasta que se aplique; los archivos manuales conservan su nombre.
const MIGRATION = "20261020150000_academic_library_documents.sql";
const MANUAL = "20261020150000";
const migration = readFileSync(path.join(root, "supabase", "migrations", MIGRATION), "utf8");
const verify = readFileSync(path.join(root, "supabase", "manual", `${MANUAL}_m4_verify.sql`), "utf8");
const rollback = readFileSync(path.join(root, "supabase", "manual", `${MANUAL}_m4_rollback.sql`), "utf8");
// Las consultas 0 y 1 del verify se corren antes de aplicar M4; de la 2 en adelante, después.
const [verifyBefore, verifyAfter] = verify.split(/^(?=-- 2\))/m);

const db = new PGlite({ extensions: { vector } });
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

const STUDENT = "00000000-0000-4000-8000-0000000000aa";
// Una sentencia como estudiante autenticado (auth.uid() = STUDENT), con la RLS de producción.
async function asStudent(sql, params = []) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [STUDENT]);
  await db.exec("set role authenticated;");
  try {
    const res = await db.query(sql, params);
    return { result: "ok", rows: res.rows, affected: res.affectedRows ?? 0 };
  } catch (e) {
    return { result: e.code || e.message, rows: [], affected: 0 };
  } finally {
    await db.exec("reset role;");
  }
}

const rowsOf = async (sql) => (await db.exec(sql)).flatMap((r) => r.rows);
const fingerprintOf = (rows) => Object.fromEntries(rows.filter((r) => "value" in r).map((r) => [r.item, r.value]));
const schemaFingerprint = async () =>
  JSON.stringify({
    cols: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
                   where table_schema = 'public' and table_name in ('documents', 'document_chunks') order by table_name, column_name`),
    cons: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
                   where conrelid in ('public.documents'::regclass, 'public.document_chunks'::regclass) order by 1, 2`),
    idx: await q(`select tablename, indexname, indexdef from pg_indexes
                  where schemaname = 'public' and tablename in ('documents', 'document_chunks') order by 1, 2`),
    trg: await q(`select tgrelid::regclass::text as tbl, tgname from pg_trigger
                  where not tgisinternal and tgrelid in ('public.documents'::regclass, 'public.document_chunks'::regclass) order by 1, 2`),
  });

const DIM = 768;
const unitVector = (seed) => {
  const values = Array.from({ length: DIM }, (_, i) => Math.sin(seed * 31 + i));
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
};
const literal = (values) => `[${values.join(",")}]`;

// ---------------- Esquema como en producción ----------------
console.log("server_version:", (await q("show server_version"))[0].server_version);
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create schema extensions;
  create extension vector schema extensions;
  create function public.set_updated_at() returns trigger language plpgsql as $$
  begin
    new.updated_at = now();
    return new;
  end
  $$;

  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    path text not null,
    description text,
    created_at timestamptz not null default now(),
    user_id uuid
  );
  create table public.document_chunks (
    id bigserial primary key,
    document_id uuid not null references public.documents(id) on delete cascade,
    chunk_index integer not null,
    content text not null,
    embedding extensions.vector(768),
    created_at timestamptz not null default now()
  );

  alter table public.documents enable row level security;
  alter table public.document_chunks enable row level security;
  create policy documents_select_own on public.documents for select to authenticated using (user_id = auth.uid());
  create policy documents_insert_own on public.documents for insert to authenticated with check (user_id = auth.uid());
  create policy documents_update_own on public.documents for update to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());
  create policy documents_delete_none on public.documents for delete to authenticated using (false);
  create policy document_chunks_select_own_doc on public.document_chunks for select to authenticated
    using (exists (select 1 from public.documents d where d.id = document_chunks.document_id and d.user_id = auth.uid()));
  create policy document_chunks_insert_own_doc on public.document_chunks for insert to authenticated
    with check (exists (select 1 from public.documents d where d.id = document_chunks.document_id and d.user_id = auth.uid()));
  create policy document_chunks_update_own_doc on public.document_chunks for update to authenticated
    using (exists (select 1 from public.documents d where d.id = document_chunks.document_id and d.user_id = auth.uid()))
    with check (exists (select 1 from public.documents d where d.id = document_chunks.document_id and d.user_id = auth.uid()));
  create policy document_chunks_delete_none on public.document_chunks for delete to authenticated using (false);

  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant select, insert, update, delete on public.documents, public.document_chunks to authenticated;
  grant usage, select on sequence public.document_chunks_id_seq to authenticated, service_role;
  grant all on public.documents, public.document_chunks to service_role;

  create function public.match_document_chunks(query_embedding extensions.vector, match_count integer default 5)
  returns table(id bigint, document_id uuid, chunk_index integer, content text, similarity double precision)
  language sql set search_path to 'public', 'extensions', 'pg_catalog' as $$
    select dc.id, dc.document_id, dc.chunk_index, dc.content, 1 - (dc.embedding <=> query_embedding) as similarity
    from document_chunks as dc
    where dc.embedding is not null
    order by dc.embedding <-> query_embedding
    limit match_count;
  $$;
  create function public.match_document_chunks(query_embedding extensions.vector, match_count integer, p_user_id uuid)
  returns table(id bigint, document_id uuid, chunk_index integer, content text, similarity double precision)
  language sql set search_path to 'public', 'extensions', 'pg_catalog' as $$
    select dc.id, dc.document_id, dc.chunk_index, dc.content, 1 - (dc.embedding <=> query_embedding) as similarity
    from public.document_chunks as dc
    join public.documents d on d.id = dc.document_id
    where dc.embedding is not null
      and (d.user_id = p_user_id or d.user_id is null)
    order by dc.embedding <-> query_embedding
    limit match_count;
  $$;

  create schema storage;
  create table storage.objects (bucket_id text not null, name text not null, metadata jsonb);
`);

// ---------------- Datos como en producción ----------------
const DEMO_ID = "c2a034c3-f840-483b-aafa-a1f45a1cc0e4";
const GUIDES = [
  ["GUIA_14.1_BALANCEO_DE_LINEA.pdf", 3, 273622],
  ["GUIA_4_TEORIA_DE_RESTRICCIONES.pdf", 4, 2209261],
  ["GUIA_14.2_BALANCEO_DE_LINEA.pdf", 7, 748535],
  ["GUIA_15_EVALUACION_FINANCIERA.pdf", 4, 725110],
  ["GUIA_8_DIAGRAMAS DE REGISTRO_1.0.pdf", 9, 606682],
  ["GUIA_9_DIAGRAMAS_DE_REGISTRO_2.0.pdf", 5, 3538691],
  ["GUIA_10_MAPEO_DE_LA_CADENA_DE_VALOR.pdf", 6, 719759],
  ["GUIA_11_TEORIA_DE_MEDICION_DEL_DESPILFARRO.pdf", 6, 1995454],
  ["GUIA_12_MUESTREO_DE_TRABAJO.pdf", 9, 990040],
  ["GUIA_13_ESTUDIO_DE_TIEMPOS.pdf", 8, 2483170],
];
const guideIds = [];
for (const [index, [file, chunks, size]] of GUIDES.entries()) {
  const [{ id }] = await q(`insert into public.documents (title, path) values ($1, $2) returning id`, [file, `mypes/${file}`]);
  guideIds.push(id);
  for (let i = 0; i < chunks; i++) {
    await q(
      `insert into public.document_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4::extensions.vector)`,
      [id, i, `${file} fragmento ${i}`, literal(unitVector(index * 100 + i))]
    );
  }
  await q(`insert into storage.objects (bucket_id, name, metadata) values ('documents', $1, $2)`, [
    `mypes/${file}`,
    JSON.stringify({ size, mimetype: "application/pdf" }),
  ]);
}
await q(`insert into public.documents (id, title, path, description) values ($1, $2, 'demo/opt-ia-demo.txt', $3)`, [
  DEMO_ID,
  "Documento demo OPT-IA productividad y ATO",
  "Texto de ejemplo.",
]);
for (let i = 0; i < 3; i++) {
  await q(
    `insert into public.document_chunks (document_id, chunk_index, content, embedding) values ($1, $2, $3, $4::extensions.vector)`,
    [DEMO_ID, i, `demo fragmento ${i}`, literal(unitVector(1000 + i))]
  );
}

// ---------------- Antes de M4 ----------------
const preRows = await rowsOf(verifyBefore);
const preconditions = preRows.filter((r) => "ok" in r);
check("verify 0: 4 condiciones previas, todas ok", preconditions.length === 4 && preconditions.every((r) => r.ok === true), JSON.stringify(preconditions));
const before = fingerprintOf(preRows);
check("antes: 11 documentos y 64 fragmentos", before.documents === "11" && before.document_chunks === "64", JSON.stringify(before));
check("antes: 2 variantes de match_document_chunks, 8 policies, 10 guías en Storage",
  before.match_document_chunks_md5.startsWith("2 variantes") && before.policies.startsWith("8 policies") && before.storage_guias.startsWith("10 objetos"));
check("antes: embedding_model no existe -> 42703", (await code(`select embedding_model from public.document_chunks`, [])) === "42703");
const schemaBefore = await schemaFingerprint();

// ---------------- Aplicar M4 ----------------
const applied = await code(migration);
check("M4 se aplica sin error", applied === "ok", applied);

const after = fingerprintOf(await rowsOf(verifyBefore));
for (const item of Object.keys(before)) {
  check(`sin cambios: ${item}`, after[item] === before[item], after[item] === before[item] ? "" : `${before[item]} -> ${after[item]}`);
}
const afterChecks = await rowsOf(verifyAfter);
check("verify 2-4: 24 comprobaciones", afterChecks.length === 24, String(afterChecks.length));
check("verify 2-4: todas ok", afterChecks.every((r) => r.ok === true), JSON.stringify(afterChecks.filter((r) => r.ok !== true)));

// El RAG actual no mira is_active: el demo sigue apareciendo hasta que el chat use otra función.
const demoQuery = literal(unitVector(1000));
const ragNow = await q(`select document_id from public.match_document_chunks($1::extensions.vector, 5, $2::uuid)`, [demoQuery, STUDENT]);
check("RAG actual (3 argumentos): el demo sigue apareciendo", ragNow.some((r) => r.document_id === DEMO_ID));
const ragTwo = await q(`select document_id from public.match_document_chunks($1::extensions.vector, 5)`, [demoQuery]);
check("RAG actual (2 argumentos): el demo sigue apareciendo", ragTwo.some((r) => r.document_id === DEMO_ID));

// ---------------- Fragmentos: convivencia y etiqueta ----------------
const NEW_MODEL = "gemini-embedding-001:768";
const insertChunk = (documentId, chunkIndex, embedding, model) =>
  code(
    `insert into public.document_chunks (document_id, chunk_index, content, embedding, embedding_model) values ($1, $2, 'nuevo', $3::extensions.vector, $4)`,
    [documentId, chunkIndex, embedding === null ? null : literal(embedding), model]
  );
const guide = guideIds[0];
check("nuevo fragmento junto al legacy, mismo índice -> ok", (await insertChunk(guide, 0, unitVector(5000), NEW_MODEL)) === "ok");
check("mismo documento, modelo e índice -> 23505", (await insertChunk(guide, 0, unitVector(5001), NEW_MODEL)) === "23505");
check("nuevo sin norma 1 -> 23514", (await insertChunk(guide, 1, unitVector(5002).map((v) => v * 2), NEW_MODEL)) === "23514");
check("nuevo sin vector -> 23514", (await insertChunk(guide, 2, null, NEW_MODEL)) === "23514");
check("etiqueta con formato inválido -> 23514", (await insertChunk(guide, 3, unitVector(5003), "Gemini 001")) === "23514");
check("sin embedding_model -> 23502",
  (await code(`insert into public.document_chunks (document_id, chunk_index, content, embedding) values ($1, 9, 'x', $2::extensions.vector)`,
    [guide, literal(unitVector(5004))])) === "23502");
const tags = await q(`select embedding_model, count(*)::int as n from public.document_chunks where document_id = $1 group by 1 order by 1`, [guide]);
check("la guía tiene sus 3 legacy-768 y 1 nuevo", JSON.stringify(tags) === JSON.stringify([
  { embedding_model: NEW_MODEL, n: 1 },
  { embedding_model: "legacy-768", n: 3 },
]), JSON.stringify(tags));

// ---------------- Documentos: valores por defecto y restricciones ----------------
const [fresh] = await q(`insert into public.documents (title, path, file_type) values ('Prueba', 'library/prueba.pdf', 'pdf') returning is_active, status, user_id`);
check("documento nuevo: inactivo, pending, global", fresh.is_active === false && fresh.status === "pending" && fresh.user_id === null);
const insertDoc = (fileType, status, error, hash) =>
  code(`insert into public.documents (title, path, file_type, status, processing_error, content_hash) values ('x', 'library/x.pdf', $1, $2, $3, $4)`,
    [fileType, status, error, hash]);
const HASH = "a".repeat(64);
check("sin file_type -> 23502", (await insertDoc(null, "pending", null, null)) === "23502");
check("file_type exe -> 23514", (await insertDoc("exe", "pending", null, null)) === "23514");
check("status desconocido -> 23514", (await insertDoc("pdf", "done", null, null)) === "23514");
check("failed sin motivo -> 23514", (await insertDoc("docx", "failed", null, null)) === "23514");
check("failed con motivo -> ok", (await insertDoc("docx", "failed", "NO_TEXT: el PDF no tiene texto extraíble.", null)) === "ok");
check("ready con motivo de error -> 23514", (await insertDoc("pdf", "ready", "x", null)) === "23514");
check("motivo de más de 300 caracteres -> 23514", (await insertDoc("pdf", "failed", "x".repeat(301), null)) === "23514");
check("hash con formato inválido -> 23514", (await insertDoc("pdf", "pending", null, "ABC")) === "23514");
check("hash válido -> ok", (await insertDoc("pdf", "pending", null, HASH)) === "ok");
check("hash repetido -> 23505", (await insertDoc("pdf", "pending", null, HASH)) === "23505");

await db.exec(`
  alter table public.documents disable trigger documents_set_updated_at;
  update public.documents set updated_at = '2000-01-01' where path = 'library/prueba.pdf';
  alter table public.documents enable trigger documents_set_updated_at;
`);
await q(`update public.documents set description = 'cambio' where path = 'library/prueba.pdf'`);
const [{ touched }] = await q(`select updated_at > '2000-01-02' as touched from public.documents where path = 'library/prueba.pdf'`);
check("updated_at se actualiza en cada cambio", touched === true);

// ---------------- RLS: un estudiante no ve ni toca los documentos globales ----------------
const seen = await asStudent(`select id from public.documents`);
check("estudiante: no lee documentos globales", seen.result === "ok" && seen.rows.length === 0, seen.result);
const toggled = await asStudent(`update public.documents set is_active = true where id = $1`, [DEMO_ID]);
const [{ demoActive }] = await q(`select is_active as "demoActive" from public.documents where id = $1`, [DEMO_ID]);
check("estudiante: no puede activar el demo", toggled.affected === 0 && demoActive === false, toggled.result);
const injected = await asStudent(
  `insert into public.document_chunks (document_id, chunk_index, content, embedding, embedding_model) values ($1, 50, 'x', $2::extensions.vector, $3)`,
  [guide, literal(unitVector(6000)), NEW_MODEL]
);
check("estudiante: no agrega fragmentos a una guía -> 42501", injected.result === "42501", injected.result);
const globalDoc = await asStudent(`insert into public.documents (title, path, file_type) values ('x', 'library/y.pdf', 'pdf')`);
check("estudiante: no crea documentos globales -> 42501", globalDoc.result === "42501", globalDoc.result);
const removed = await asStudent(`delete from public.document_chunks where document_id = $1`, [guide]);
check("estudiante: no borra fragmentos", removed.affected === 0, removed.result);

// ---------------- Reaplicar y revertir ----------------
const schemaAfter = await schemaFingerprint();
const again = await code(migration);
await code("rollback;");
check("reaplicar M4 falla sin cambiar nada", again !== "ok" && (await schemaFingerprint()) === schemaAfter, again);

const refused = await code(rollback);
await code("rollback;");
check("rollback se niega con fragmentos de otro modelo", refused !== "ok" && (await schemaFingerprint()) === schemaAfter, refused);

// Sin fragmentos nuevos ni documentos de prueba (solo en esta prueba), el rollback restaura todo.
await db.exec(`
  delete from public.document_chunks where embedding_model <> 'legacy-768';
  delete from public.documents where path like 'library/%';
`);
const rolled = await code(rollback);
check("rollback sin fragmentos nuevos se aplica", rolled === "ok", rolled);
check("rollback: esquema original", (await schemaFingerprint()) === schemaBefore);
const restored = fingerprintOf(await rowsOf(verifyBefore));
check("rollback: datos, funciones, policies y grants como antes", JSON.stringify(restored) === JSON.stringify(before));

const reapplied = await code(migration);
const recheck = await rowsOf(verifyAfter);
check("re-aplicar tras rollback", reapplied === "ok" && recheck.length === 24 && recheck.every((r) => r.ok === true), reapplied);

console.log(failures === 0 ? "\nM4: todas las comprobaciones pasaron." : `\nM4: ${failures} comprobaciones fallaron.`);
process.exit(failures === 0 ? 0 : 1);
