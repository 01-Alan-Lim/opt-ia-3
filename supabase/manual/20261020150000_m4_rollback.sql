-- Reversión completa de M4 (20261020150000_academic_library_documents).
-- Fuera de supabase/migrations a propósito: no lo aplica db push. Ejecutar solo a mano.
--
-- Lo preferible es NO correr esto: M4 solo agrega columnas que el código actual no usa.
-- Se niega a continuar si ya hay fragmentos con una etiqueta distinta de legacy-768: sin la
-- columna embedding_model quedarían mezclados con los antiguos, sin forma de separarlos. Borrar
-- esos fragmentos (o no) es una decisión aparte, que no se toma aquí.
--
-- Se pierden is_active, status, file_type, content_hash, processing_error, updated_at y
-- embedding_model. Los documentos, los fragmentos, sus embeddings y Storage quedan como están.

begin;

do $$
begin
  if exists (select 1 from public.document_chunks where embedding_model <> 'legacy-768') then
    raise exception 'Hay fragmentos de otro modelo de embedding: revertir M4 los mezclaría con los antiguos.';
  end if;
end
$$;

drop index if exists public.document_chunks_document_model_chunk_key;
alter table public.document_chunks
  drop constraint if exists document_chunks_unit_norm,
  drop constraint if exists document_chunks_embedding_model_format,
  drop column if exists embedding_model;

drop trigger if exists documents_set_updated_at on public.documents;
drop index if exists public.documents_content_hash_key;
alter table public.documents
  drop constraint if exists documents_processing_error_check,
  drop constraint if exists documents_content_hash_format,
  drop constraint if exists documents_file_type_check,
  drop constraint if exists documents_status_check,
  drop column if exists updated_at,
  drop column if exists processing_error,
  drop column if exists content_hash,
  drop column if exists file_type,
  drop column if exists status,
  drop column if exists is_active;

commit;

notify pgrst, 'reload schema';
