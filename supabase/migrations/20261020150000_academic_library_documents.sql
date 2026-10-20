-- academic_library_documents
--
-- M4 — Biblioteca Académica: estado de los documentos y modelo de cada vector. Solo agrega.
--
-- QUÉ CAMBIA
--   public.documents (hoy 11 filas: 10 guías PDF en mypes/ y el demo demo/opt-ia-demo.txt):
--     1. is_active boolean not null default false: si el documento participa en el RAG nuevo.
--        Las guías quedan activas; el demo, inactivo. Una fila nueva nace inactiva.
--     2. status text not null default 'pending': pending (sin indexar con el motor actual),
--        processing, ready o failed. Las 11 quedan en pending: sus vectores son anteriores.
--     3. file_type text not null: pdf, docx o txt, según la extensión de path (las 10 guías son
--        pdf; el demo, txt). La Biblioteca solo aceptará pdf y docx; txt existe por el demo.
--     4. content_hash text: SHA-256 (hex) del archivo original, único cuando existe (detecta
--        duplicados). NULL en las 11: se calcula al reindexar desde Storage.
--     5. processing_error text (hasta 300 caracteres): motivo del último fallo; está si y solo si
--        status = 'failed'.
--     6. updated_at timestamptz (public.set_updated_at): permite ver un processing que quedó colgado.
--   public.document_chunks (hoy 64 filas: 61 de las guías y 3 del demo):
--     7. embedding_model text not null, sin valor por defecto: etiqueta del vector. El motor nuevo
--        (src/lib/embeddingEngine.ts) escribe "gemini-embedding-001:768"; los 64 actuales quedan
--        'legacy-768' (otro modelo, text-embedding-004 según la auditoría) y nunca se comparan con
--        los nuevos. Quien inserte un fragmento tiene que declarar su modelo.
--     8. Único (document_id, embedding_model, chunk_index): los fragmentos antiguos y los nuevos de
--        una guía conviven durante la reindexación sin pisarse, y un reintento no los duplica.
--     9. CHECK: un fragmento que no es legacy-768 tiene vector y norma 1 (el motor normaliza).
--   No cambian los embeddings ni el contenido de los fragmentos, user_id, las dos variantes de
--   match_document_chunks, las policies, los grants ni Storage. No se borra nada.
--
-- DEPENDENCIA CON EL CÓDIGO
--   El código actual no lee ni escribe estas columnas. /api/chat sigue usando
--   match_document_chunks, que no mira is_active: el demo SIGUE en el RAG actual hasta que el chat
--   use una función nueva que filtre por is_active, status y embedding_model. Las rutas
--   /api/dev/index-* (sin permisos con el cliente anon y bloqueadas en producción) además
--   fallarían ahora por file_type y embedding_model obligatorios.
--
-- SEGURIDAD
--   Ningún grant ni policy nuevo. Las de hoy (documents_*_own y document_chunks_*_own_doc, con
--   user_id = auth.uid(), y delete negado) ya impiden que un cliente lea, cree o modifique los
--   documentos globales (user_id NULL) o sus fragmentos. La Biblioteca escribirá con service role
--   desde rutas con requireTeacher.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Si un documento tuviera otra extensión, si hubiera fragmentos repetidos por
--   (document_id, chunk_index) o si faltara public.set_updated_at, la migración se detiene y no
--   cambia nada: es una sola transacción. Reaplicarla también falla sin cambios (columnas ya
--   existentes). Toma bloqueos breves sobre documents y document_chunks (75 filas en total).
--
-- CÓMO SE REVIERTE
--   Preferible: dejarla, porque el código actual no la usa.
--   Reversión completa: supabase/manual/20261020150000_m4_rollback.sql (se niega si ya hay
--   fragmentos de otro modelo: sin la etiqueta quedarían indistinguibles de los antiguos).

begin;

do $$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'M4: falta public.set_updated_at().';
  end if;
  if exists (select 1 from public.documents where path !~* '\.(pdf|docx|txt)$') then
    raise exception 'M4: hay documentos con una extensión distinta de pdf, docx o txt.';
  end if;
  if exists (
    select 1 from public.document_chunks group by document_id, chunk_index having count(*) > 1
  ) then
    raise exception 'M4: hay fragmentos repetidos por (document_id, chunk_index).';
  end if;
end
$$;

-- documents ------------------------------------------------------------------

alter table public.documents
  add column is_active boolean not null default false,
  add column status text not null default 'pending',
  add column file_type text,
  add column content_hash text,
  add column processing_error text,
  add column updated_at timestamptz not null default now();

update public.documents
set file_type = case
      when path ~* '\.pdf$' then 'pdf'
      when path ~* '\.docx$' then 'docx'
      else 'txt'
    end,
    is_active = not (id = 'c2a034c3-f840-483b-aafa-a1f45a1cc0e4' or path = 'demo/opt-ia-demo.txt');

alter table public.documents
  alter column file_type set not null,
  add constraint documents_status_check
    check (status in ('pending', 'processing', 'ready', 'failed')),
  add constraint documents_file_type_check
    check (file_type in ('pdf', 'docx', 'txt')),
  add constraint documents_content_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  add constraint documents_processing_error_check
    check ((status = 'failed') = (processing_error is not null)
           and (processing_error is null or char_length(processing_error) <= 300));

create unique index documents_content_hash_key
  on public.documents (content_hash)
  where content_hash is not null;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

comment on column public.documents.is_active is
  'Participa en el RAG de la Biblioteca Académica. Una fila nueva nace inactiva.';
comment on column public.documents.status is
  'Indexación con el motor actual: pending, processing, ready o failed.';
comment on column public.documents.file_type is
  'pdf o docx (Biblioteca Académica); txt solo por el documento demo.';
comment on column public.documents.content_hash is
  'SHA-256 (hex) del archivo original. Único: detecta duplicados.';
comment on column public.documents.processing_error is
  'Motivo del último fallo de procesamiento. Solo con status failed.';

-- document_chunks -------------------------------------------------------------

alter table public.document_chunks add column embedding_model text;

update public.document_chunks set embedding_model = 'legacy-768';

alter table public.document_chunks
  alter column embedding_model set not null,
  add constraint document_chunks_embedding_model_format
    check (embedding_model = 'legacy-768' or embedding_model ~ '^[a-z0-9][a-z0-9._-]*:[1-9][0-9]*$'),
  add constraint document_chunks_unit_norm
    check (embedding_model = 'legacy-768'
           or (embedding is not null and abs(extensions.vector_norm(embedding) - 1) <= 1e-3));

create unique index document_chunks_document_model_chunk_key
  on public.document_chunks (document_id, embedding_model, chunk_index);

comment on column public.document_chunks.embedding_model is
  'Etiqueta del vector: modelo:dimensión del motor (gemini-embedding-001:768) o legacy-768 para los anteriores. Solo se comparan vectores con la misma etiqueta.';

commit;

-- PostgREST tiene que ver las columnas nuevas.
notify pgrst, 'reload schema';

-- Verificación (solo lectura), antes y después: supabase/manual/20261020150000_m4_verify.sql
