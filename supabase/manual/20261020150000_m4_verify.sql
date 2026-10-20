-- Verificación de M4 (20261020150000_academic_library_documents). SOLO LECTURA.
-- Fuera de supabase/migrations a propósito: no lo aplica db push.
-- Las consultas 0 y 1 se corren ANTES de aplicar M4; la 1 se repite DESPUÉS y tiene que dar
-- exactamente lo mismo (es lo que M4 no debe tocar). Las consultas 2 a 4, solo después: cada fila
-- trae ok = true si la comprobación pasa.

-- 0) Antes: lo que M4 exige para aplicarse (si algo da false, la migración se detendría).
select 'set_updated_at' as item, to_regprocedure('public.set_updated_at()') is not null as ok,
       coalesce(to_regprocedure('public.set_updated_at()')::text, 'no existe') as detail
union all
select 'extensiones_validas', count(*) filter (where path !~* '\.(pdf|docx|txt)$') = 0,
       count(*) filter (where path !~* '\.(pdf|docx|txt)$') || ' documentos con otra extensión'
from public.documents
union all
select 'sin_fragmentos_repetidos', count(*) = 0, count(*) || ' pares (document_id, chunk_index) repetidos'
from (select 1 from public.document_chunks group by document_id, chunk_index having count(*) > 1) d
union all
select 'vector_norm', to_regprocedure('extensions.vector_norm(extensions.vector)') is not null,
       coalesce(to_regprocedure('extensions.vector_norm(extensions.vector)')::text, 'no existe');
-- Esperado: 4 filas, todas ok = true.

-- 1) Huella de lo que M4 no toca (antes y después: idéntica, fila por fila).
select 'documents' as item, count(*)::text as value from public.documents
union all
select 'document_chunks', count(*)::text from public.document_chunks
union all
select 'chunks_por_documento', string_agg(document_id || '=' || n, ',' order by document_id)
from (select document_id, count(*) as n from public.document_chunks group by document_id) c
union all
select 'documents_md5',
       md5(string_agg(concat_ws('|', id, title, path, description, user_id, created_at), E'\n' order by id))
from public.documents
union all
select 'chunks_content_md5',
       md5(string_agg(concat_ws('|', id, document_id, chunk_index, content, created_at), E'\n' order by id))
from public.document_chunks
union all
select 'chunks_embedding_md5', md5(string_agg(coalesce(embedding::text, 'null'), E'\n' order by id))
from public.document_chunks
union all
select 'match_document_chunks_md5',
       count(*) || ' variantes, ' || md5(string_agg(pg_get_functiondef(p.oid), E'\n' order by p.oid::regprocedure::text))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'match_document_chunks'
union all
select 'policies',
       count(*) || ' policies, ' || md5(string_agg(concat_ws('|', tablename, policyname, cmd, roles, qual, with_check), E'\n' order by tablename, policyname))
from pg_policies where schemaname = 'public' and tablename in ('documents', 'document_chunks')
union all
select 'grants', string_agg(r.role || '.' || t.tbl || '.' || p.priv || '=' || has_table_privilege(r.role, 'public.' || t.tbl, p.priv), ',' order by r.role, t.tbl, p.priv)
from (values ('anon'), ('authenticated')) r(role)
cross join (values ('documents'), ('document_chunks')) t(tbl)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
union all
select 'rls', string_agg(relname || '=' || relrowsecurity, ',' order by relname)
from pg_class where oid in ('public.documents'::regclass, 'public.document_chunks'::regclass)
union all
select 'storage_guias', count(*) || ' objetos, ' || coalesce(sum((metadata->>'size')::bigint), 0) || ' bytes'
from storage.objects where bucket_id = 'documents' and name like 'mypes/%';
-- Esperado hoy: documents 11, document_chunks 64, match_document_chunks 2 variantes, policies 8,
-- storage_guias 10 objetos. El resto se compara con el valor previo.

-- 2) Después: esquema nuevo.
select 'col_documents.' || column_name as item,
       case column_name
         when 'is_active' then data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
         when 'status' then data_type = 'text' and is_nullable = 'NO' and column_default = '''pending''::text'
         when 'file_type' then data_type = 'text' and is_nullable = 'NO' and column_default is null
         when 'updated_at' then data_type = 'timestamp with time zone' and is_nullable = 'NO'
         else data_type = 'text' and is_nullable = 'YES' and column_default is null
       end as ok,
       data_type || ' nullable=' || is_nullable || ' default=' || coalesce(column_default, '-') as detail
from information_schema.columns
where table_schema = 'public' and table_name = 'documents'
  and column_name in ('is_active', 'status', 'file_type', 'content_hash', 'processing_error', 'updated_at')
union all
select 'col_document_chunks.' || column_name, data_type = 'text' and is_nullable = 'NO' and column_default is null,
       data_type || ' nullable=' || is_nullable || ' default=' || coalesce(column_default, '-')
from information_schema.columns
where table_schema = 'public' and table_name = 'document_chunks' and column_name = 'embedding_model'
union all
select conname, convalidated, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('public.documents'::regclass, 'public.document_chunks'::regclass)
  and conname in ('documents_status_check', 'documents_file_type_check', 'documents_content_hash_format',
                  'documents_processing_error_check', 'document_chunks_embedding_model_format',
                  'document_chunks_unit_norm')
union all
select indexname, indexdef like 'CREATE UNIQUE INDEX%', indexdef
from pg_indexes
where schemaname = 'public' and indexname in ('documents_content_hash_key', 'document_chunks_document_model_chunk_key')
union all
select 'trigger_documents_set_updated_at', count(*) = 1, coalesce(string_agg(action_timing || ' ' || event_manipulation, ','), 'no existe')
from information_schema.triggers
where event_object_schema = 'public' and event_object_table = 'documents' and trigger_name = 'documents_set_updated_at';
-- Esperado: 16 filas (7 columnas, 6 constraints, 2 índices, 1 trigger), todas ok = true.

-- 3) Después: datos.
select 'documentos_pending' as item, count(*) filter (where status <> 'pending') = 0 as ok,
       count(*) filter (where status = 'pending') || ' de ' || count(*) as detail
from public.documents
union all
select 'guias_activas_pdf',
       count(*) filter (where is_active) = count(*) filter (where path <> 'demo/opt-ia-demo.txt')
         and count(*) filter (where is_active and file_type <> 'pdf') = 0,
       count(*) filter (where is_active) || ' activas, ' || count(*) filter (where file_type = 'pdf') || ' pdf'
from public.documents
union all
select 'demo_inactivo_txt', count(*) = 1 and bool_and(not is_active and file_type = 'txt' and status = 'pending'),
       count(*) || ' fila(s)'
from public.documents where path = 'demo/opt-ia-demo.txt'
union all
select 'sin_hash_ni_error', count(content_hash) = 0 and count(processing_error) = 0,
       count(content_hash) || ' hash, ' || count(processing_error) || ' errores'
from public.documents
union all
select 'fragmentos_legacy_768', count(*) filter (where embedding_model <> 'legacy-768') = 0,
       count(*) filter (where embedding_model = 'legacy-768') || ' de ' || count(*)
from public.document_chunks
union all
select 'fragmentos_demo_conservados', count(*) = 3, count(*) || ' fragmentos'
from public.document_chunks c join public.documents d on d.id = c.document_id
where d.path = 'demo/opt-ia-demo.txt';
-- Esperado: 6 filas, todas ok = true (11 pending; 10 activas y pdf; demo inactivo; 64 legacy-768;
-- 3 fragmentos del demo).

-- 4) Después: anon sigue sin privilegios y la RLS sigue activa (además de la huella de la consulta 1).
select 'anon_sin_privilegios' as item,
       not bool_or(has_table_privilege('anon', 'public.' || t.tbl, p.priv)) as ok,
       'documents, document_chunks' as detail
from (values ('documents'), ('document_chunks')) t(tbl)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
union all
select 'rls_activa', bool_and(relrowsecurity), string_agg(relname, ',' order by relname)
from pg_class where oid in ('public.documents'::regclass, 'public.document_chunks'::regclass);
-- Esperado: 2 filas, ok = true.
