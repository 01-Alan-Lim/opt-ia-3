// Prueba de M6 (20261020200000_academic_library_rag) en un Postgres en memoria (PGlite) con
// pgvector, después de M4 y M5 en el orden en que se aplican. No toca ninguna base real.
//
// Uso: node supabase/tests/m6_academic_rag.pglite.mjs <carpeta-con-node_modules/@electric-sql/pglite>
// PGlite no es dependencia del proyecto: se instala aparte en una carpeta temporal y se pasa su
// ruta (npm i @electric-sql/pglite @electric-sql/pglite-pgvector).
//
// Comprueba que match_academic_chunks y academic_library_available solo usan documentos activos,
// listos, globales o del usuario, con el mismo modelo de embedding; que rechazan legacy-768; que
// solo service_role las ejecuta; y que las dos variantes de match_document_chunks no cambian.

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

const migration = (name) => readFileSync(path.join(root, "supabase", "migrations", name), "utf8");
const M4 = migration("20261020150000_academic_library_documents.sql");
const M5 = migration("20261020180000_academic_library_client_writes.sql");
const M6 = migration("20261020200000_academic_library_rag.sql");

const db = new PGlite({ extensions: { vector } });
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

const DIM = 768;
const CURRENT = "gemini-embedding-001:768";
const unit = (values) => {
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
};
const literal = (values) => `[${values.join(",")}]`;
const QUERY = unit(Array.from({ length: DIM }, (_, i) => Math.sin(i + 1)));
const OPPOSITE = QUERY.map((v) => -v);

// ---------------- Esquema como en producción (antes de M4) ----------------
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
  grant select, insert, update, delete, truncate on public.documents, public.document_chunks to authenticated;
  grant usage, select on sequence public.document_chunks_id_seq to authenticated, service_role;
  grant all on public.documents, public.document_chunks to service_role;

  create function public.match_document_chunks(query_embedding extensions.vector, match_count integer default 5)
  returns table(id bigint, document_id uuid, chunk_index integer, content text, similarity double precision)
  language sql set search_path to 'public', 'extensions', 'pg_catalog' as $$
    select dc.id, dc.document_id, dc.chunk_index, dc.content, 1 - (dc.embedding <=> query_embedding) as similarity
    from document_chunks as dc where dc.embedding is not null
    order by dc.embedding <-> query_embedding limit match_count;
  $$;
  create function public.match_document_chunks(query_embedding extensions.vector, match_count integer, p_user_id uuid)
  returns table(id bigint, document_id uuid, chunk_index integer, content text, similarity double precision)
  language sql set search_path to 'public', 'extensions', 'pg_catalog' as $$
    select dc.id, dc.document_id, dc.chunk_index, dc.content, 1 - (dc.embedding <=> query_embedding) as similarity
    from public.document_chunks as dc join public.documents d on d.id = dc.document_id
    where dc.embedding is not null and (d.user_id = p_user_id or d.user_id is null)
    order by dc.embedding <-> query_embedding limit match_count;
  $$;
  -- Supabase concede EXECUTE por defecto a las funciones nuevas de public.
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);

const oldFunctions = async () =>
  (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) as h
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'match_document_chunks'`))[0].h;
const oldBefore = await oldFunctions();

check("M4 se aplica", (await code(M4)) === "ok");
check("M5 se aplica", (await code(M5)) === "ok");
const m6 = await code(M6);
check("M6 se aplica", m6 === "ok", m6);
check("las dos variantes antiguas no cambian", (await oldFunctions()) === oldBefore);

// ---------------- Datos ----------------
const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const docs = {
  ready: { user: null, status: "ready", active: true },
  inactive: { user: null, status: "ready", active: false },
  pending: { user: null, status: "pending", active: true },
  processing: { user: null, status: "processing", active: true },
  failed: { user: null, status: "failed", active: true },
  legacy: { user: null, status: "pending", active: true },
  legacyReady: { user: null, status: "ready", active: true },
  demo: { user: null, status: "pending", active: false, file: "txt" },
  ownA: { user: A, status: "ready", active: true },
  ownB: { user: B, status: "ready", active: true },
  otherModel: { user: null, status: "ready", active: true },
};
const ids = {};
for (const [name, d] of Object.entries(docs)) {
  const [{ id }] = await q(
    `insert into public.documents (title, path, user_id, file_type, status, is_active, processing_error)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [name, `library/${name}.${d.file ?? "pdf"}`, d.user, d.file ?? "pdf", d.status, d.active, d.status === "failed" ? "SAVE: prueba" : null]
  );
  ids[name] = id;
}
const addChunk = (doc, index, content, embedding, model = CURRENT) =>
  q(`insert into public.document_chunks (document_id, chunk_index, content, embedding, embedding_model)
     values ($1, $2, $3, $4::extensions.vector, $5)`, [ids[doc], index, content, literal(embedding), model]);
await addChunk("ready", 0, "LISTO-PARECIDO", QUERY);
await addChunk("ready", 1, "LISTO-OPUESTO", OPPOSITE);
await addChunk("inactive", 0, "INACTIVO", QUERY);
await addChunk("pending", 0, "PENDIENTE", QUERY);
await addChunk("processing", 0, "PROCESANDO", QUERY);
await addChunk("failed", 0, "FALLIDO", QUERY);
await addChunk("legacy", 0, "LEGACY", QUERY, "legacy-768");
await addChunk("legacyReady", 0, "LEGACY-LISTO", QUERY, "legacy-768");
await addChunk("demo", 0, "DEMO ATO", QUERY, "legacy-768");
await addChunk("ownA", 0, "PROPIO-A", QUERY);
await addChunk("ownB", 0, "PROPIO-B", QUERY);
await addChunk("otherModel", 0, "OTRO-MODELO", QUERY, "text-embedding-004:768");

const search = async (user, { count = 10, model = CURRENT, min = 0 } = {}) =>
  (await q(`select content, similarity from public.match_academic_chunks($1::extensions.vector, $2, $3, $4::uuid, $5)`,
    [literal(QUERY), count, model, user, min])).map((r) => r.content);
const available = async (model, user) =>
  (await q(`select public.academic_library_available($1, $2::uuid) as ok`, [model, user]))[0].ok;

// ---------------- Búsqueda ----------------
check("global: solo el documento activo y listo", JSON.stringify(await search(null)) === JSON.stringify(["LISTO-PARECIDO"]), JSON.stringify(await search(null)));
check("usuario A: lo global y lo suyo", JSON.stringify((await search(A)).sort()) === JSON.stringify(["LISTO-PARECIDO", "PROPIO-A"]));
check("usuario B: lo global y lo suyo, nunca lo de A", JSON.stringify((await search(B)).sort()) === JSON.stringify(["LISTO-PARECIDO", "PROPIO-B"]));
const all = await search(A, { min: -1 });
for (const excluded of ["INACTIVO", "PENDIENTE", "PROCESANDO", "FALLIDO", "LEGACY", "LEGACY-LISTO", "DEMO ATO", "PROPIO-B", "OTRO-MODELO"]) {
  check(`nunca: ${excluded}`, !all.includes(excluded));
}
check("umbral: lo opuesto entra solo con umbral -1", all.includes("LISTO-OPUESTO") && !(await search(A)).includes("LISTO-OPUESTO"));
const ordered = await q(`select content, similarity from public.match_academic_chunks($1::extensions.vector, 10, $2, null, -1)`, [literal(QUERY), CURRENT]);
check("orden por similitud", ordered[0].content === "LISTO-PARECIDO" && Math.abs(ordered[0].similarity - 1) < 1e-4 && ordered[1].similarity < 0);
check("cantidad: 1 fila", (await search(A, { count: 1 })).length === 1);
check("cantidad: 0 no devuelve nada", (await search(A, { count: 0 })).length === 0);
check("otro modelo: solo sus vectores", JSON.stringify(await search(null, { model: "text-embedding-004:768" })) === JSON.stringify(["OTRO-MODELO"]));
for (const bad of ["legacy-768", "Gemini 001", "gemini-embedding-001"]) {
  check(`modelo ${bad} -> 22023`, (await code(`select * from public.match_academic_chunks($1::extensions.vector, 5, $2)`, [literal(QUERY), bad])) === "22023");
}
check("modelo NULL -> 22023", (await code(`select * from public.match_academic_chunks($1::extensions.vector, 5, null)`, [literal(QUERY)])) === "22023");

await db.exec("begin;");
for (let i = 2; i < 30; i++) await addChunk("ready", i, `EXTRA-${i}`, QUERY);
const capped = await search(null, { count: 500 });
await db.exec("rollback;");
check("tope de 20 filas", capped.length === 20, String(capped.length));

// ---------------- Disponibilidad ----------------
check("disponible: global", (await available(CURRENT, null)) === true);
check("legacy-768 nunca está disponible", (await available("legacy-768", null)) === false);
await q(`update public.documents set is_active = false where id = $1`, [ids.ready]);
check("sin global activo: no disponible para nadie más", (await available(CURRENT, null)) === false);
check("sin global activo: A sigue con lo suyo", (await available(CURRENT, A)) === true);
await q(`update public.documents set is_active = false where id in ($1, $2)`, [ids.ownA, ids.ownB]);
check("solo legacy, inactivos, pendientes o fallidos: no disponible", (await available(CURRENT, A)) === false && (await search(A, { min: -1 })).length === 0);
await q(`update public.documents set is_active = true where id in ($1, $2, $3)`, [ids.ready, ids.ownA, ids.ownB]);

// ---------------- Permisos ----------------
const fnPrivileges = await q(`
  select p.proname, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as can
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
  where n.nspname = 'public' and p.proname in ('match_academic_chunks', 'academic_library_available')`);
check("6 combinaciones de función y rol", fnPrivileges.length === 6);
check("anon y authenticated sin EXECUTE", fnPrivileges.filter((r) => r.role !== "service_role").every((r) => r.can === false));
check("service_role con EXECUTE", fnPrivileges.filter((r) => r.role === "service_role").every((r) => r.can === true));
await db.exec(`set role authenticated;`);
const denied = await code(`select * from public.match_academic_chunks($1::extensions.vector, 5, $2, null, 0)`, [literal(QUERY), CURRENT]);
await db.exec(`reset role;`);
check("authenticated no puede llamarla -> 42501", denied === "42501", denied);

// M5: authenticated queda solo con lectura.
const tablePrivileges = await q(`
  select t.tbl, p.priv, has_table_privilege('authenticated', 'public.' || t.tbl, p.priv) as granted
  from (values ('documents'), ('document_chunks')) t(tbl)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)`);
check("M5: SELECT sí, escritura no", tablePrivileges.every((r) => r.granted === (r.priv === "SELECT")), JSON.stringify(tablePrivileges.filter((r) => r.granted !== (r.priv === "SELECT"))));
const policies = await q(`select policyname from pg_policies where schemaname = 'public' and tablename in ('documents', 'document_chunks') order by 1`);
check("M5: quedan 4 policies de lectura y delete", JSON.stringify(policies.map((p) => p.policyname)) ===
  JSON.stringify(["document_chunks_delete_none", "document_chunks_select_own_doc", "documents_delete_none", "documents_select_own"]));

// ---------------- Reaplicar y revertir ----------------
check("M6 se puede reaplicar", (await code(M6)) === "ok" && JSON.stringify(await search(null)) === JSON.stringify(["LISTO-PARECIDO"]));
const reverted = await code(`
  drop function public.match_academic_chunks(extensions.vector, integer, text, uuid, double precision);
  drop function public.academic_library_available(text, uuid);
`);
const left = await q(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname in ('match_academic_chunks', 'academic_library_available')`);
check("reversión: funciones nuevas fuera", reverted === "ok" && left[0].n === 0);
check("reversión: las antiguas siguen iguales", (await oldFunctions()) === oldBefore);

console.log(failures === 0 ? "\nM6: todas las comprobaciones pasaron." : `\nM6: ${failures} comprobaciones fallaron.`);
process.exit(failures === 0 ? 0 : 1);
