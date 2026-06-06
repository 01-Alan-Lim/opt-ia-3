-- =============================================================================
-- Migración: hacer privado el bucket de Storage "documents" y eliminar
--            las políticas públicas peligrosas detectadas en la auditoría.
-- Rama:      fix/storage-documents-private
-- Fecha:     2026-06-06
-- =============================================================================
--
-- CONTEXTO / POR QUÉ
-- -----------------------------------------------------------------------------
-- La auditoría de Supabase detectó que el bucket "documents" está marcado como
-- público (public = true) y tiene 3 políticas sobre storage.objects que conceden
-- acceso amplio a los roles anon y authenticated:
--   - SELECT  -> cualquiera puede LEER y LISTAR todos los objetos del bucket.
--   - INSERT  -> cualquiera puede SUBIR objetos.
--   - UPDATE  -> cualquiera puede SOBRESCRIBIR objetos existentes.
-- Esto expone documentos de estudiantes (p. ej. PDFs de planes en
-- plans/{userId}/stage-10/{chatId}/...) a lectura/escritura no autenticada.
--
-- POR QUÉ ES SEGURO PRIVATIZAR
-- -----------------------------------------------------------------------------
-- El código de la app NO depende del acceso público ni de las políticas anon:
--   * /api/plans/upload sube los archivos usando el cliente service_role
--     (supabaseServer), que IGNORA el flag public y las políticas RLS de
--     storage.objects. Por lo tanto la subida real seguirá funcionando.
--   * No existe en el repo ningún uso de getPublicUrl, createSignedUrl,
--     download, list ni remove: la app NUNCA lee/descarga archivos desde
--     Storage. El texto extraído de los PDF/DOCX se guarda en tablas
--     (document_chunks, plan_stage_artifacts.payload, plan_stage_states), y el
--     "storagePath" se almacena solo como referencia (string), nunca como URL.
--   * La RAG (match_document_chunks) lee la TABLA document_chunks, no Storage.
--
-- IMPACTO CONOCIDO
-- -----------------------------------------------------------------------------
-- El ÚNICO flujo que depende de la política anon INSERT es la página de
-- desarrollo /dev/index-pdf (sube desde el navegador con el cliente anon).
-- Esa página se ajustará en un cambio posterior (mover la subida a un endpoint
-- server con requireUser + service_role, o gatearla por entorno). NO se toca
-- en esta migración.
--
-- QUÉ SE ROMPE SI NO SE HACE
-- -----------------------------------------------------------------------------
-- Si NO se aplica, el bucket sigue siendo público: cualquier persona en
-- internet puede listar, descargar, subir y sobrescribir documentos del bucket
-- (incluidos los planes subidos por estudiantes), lo que constituye una fuga de
-- datos y un riesgo de manipulación de archivos.
--
-- POLÍTICAS NUEVAS
-- -----------------------------------------------------------------------------
-- No se crean políticas nuevas en esta migración. La app sube con service_role,
-- que no requiere políticas. Cualquier descarga futura deberá implementarse con
-- signed URLs (createSignedUrl) generadas desde un endpoint server que valide la
-- propiedad (ownership) del recurso antes de emitir la URL temporal. NO usar
-- getPublicUrl.
-- =============================================================================

-- 1) Hacer privado el bucket "documents".
update storage.buckets
set public = false
where id = 'documents';

-- 2) Eliminar las 3 políticas públicas peligrosas confirmadas por la auditoría.
--    (idempotente: "if exists" permite re-ejecutar sin error)
drop policy if exists "Allow anon all on documents flreew_0" on storage.objects; -- SELECT amplio (anon, authenticated)
drop policy if exists "Allow anon all on documents flreew_1" on storage.objects; -- INSERT amplio (anon, authenticated)
drop policy if exists "Allow anon all on documents flreew_2" on storage.objects; -- UPDATE amplio (anon, authenticated)

-- =============================================================================
-- FIN DE LA MIGRACIÓN
-- =============================================================================
