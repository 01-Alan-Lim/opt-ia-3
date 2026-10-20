-- academic_library_client_writes
--
-- M5 — Biblioteca Académica: documents y document_chunks pasan a solo lectura para authenticated.
--
-- QUÉ CAMBIA
--   Hoy authenticated tiene INSERT, UPDATE y DELETE sobre documents y document_chunks, con las
--   policies documents_insert_own, documents_update_own, document_chunks_insert_own_doc y
--   document_chunks_update_own_doc (user_id = auth.uid()). Con la anon key y su sesión, un
--   estudiante puede crear documentos PROPIOS con fragmentos, y la variante de 3 argumentos de
--   match_document_chunks (la que usa /api/chat) devuelve también los documentos de p_user_id:
--   podría meter texto suyo en las respuestas de su asistente. Los documentos globales
--   (user_id NULL, los de la Biblioteca) ya están a salvo: ninguna policy deja tocarlos.
--   Se quitan INSERT, UPDATE, DELETE y TRUNCATE a authenticated en las dos tablas y las cuatro
--   policies de escritura. Quedan SELECT, las policies de lectura propia y las de delete en false
--   (ya no hacen falta, pero no estorban).
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada de la aplicación: el navegador no escribe estas tablas (su única subida es a Storage, en
--   /dev/index-pdf). Escriben con service role /api/teacher/library y
--   /api/teacher/library/:id/process. Las rutas /api/dev/index-* usan el cliente anon, que ya no
--   tiene privilegios (revoke_broad_anon_grants), y están bloqueadas en producción.
--   anon, service_role y Storage (bucket privado, sin policies) no cambian.
--
-- CÓMO SE REVIERTE
--   El bloque REVERSIÓN EXACTA del final (las policies tal cual están hoy en pg_policies).
--   TRUNCATE no se devuelve: la RLS no lo cubre y ningún código lo usa.

begin;

revoke insert, update, delete, truncate on public.documents, public.document_chunks from authenticated;

drop policy if exists documents_insert_own on public.documents;
drop policy if exists documents_update_own on public.documents;
drop policy if exists document_chunks_insert_own_doc on public.document_chunks;
drop policy if exists document_chunks_update_own_doc on public.document_chunks;

commit;

notify pgrst, 'reload schema';

-- VERIFICACIÓN (solo lectura, después de aplicar):
--
--   select t.tbl, p.priv, has_table_privilege('authenticated', 'public.' || t.tbl, p.priv) as granted
--   from (values ('documents'), ('document_chunks')) t(tbl)
--   cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
--   order by 1, 2;
--   -- Esperado: SELECT true; INSERT, UPDATE, DELETE y TRUNCATE false, en las dos tablas.
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' and tablename in ('documents', 'document_chunks')
--   order by 1, 2;
--   -- Esperado: 4 filas (document_chunks_delete_none, document_chunks_select_own_doc,
--   -- documents_delete_none, documents_select_own).
--
-- REVERSIÓN EXACTA (copiar y ejecutar si hiciera falta):
--
--   grant insert, update, delete on public.documents, public.document_chunks to authenticated;
--
--   create policy documents_insert_own on public.documents
--     for insert to authenticated
--     with check (user_id = auth.uid());
--
--   create policy documents_update_own on public.documents
--     for update to authenticated
--     using (user_id = auth.uid())
--     with check (user_id = auth.uid());
--
--   create policy document_chunks_insert_own_doc on public.document_chunks
--     for insert to authenticated
--     with check (exists (select 1 from public.documents d
--                         where d.id = document_chunks.document_id and d.user_id = auth.uid()));
--
--   create policy document_chunks_update_own_doc on public.document_chunks
--     for update to authenticated
--     using (exists (select 1 from public.documents d
--                    where d.id = document_chunks.document_id and d.user_id = auth.uid()))
--     with check (exists (select 1 from public.documents d
--                         where d.id = document_chunks.document_id and d.user_id = auth.uid()));
--
--   notify pgrst, 'reload schema';
