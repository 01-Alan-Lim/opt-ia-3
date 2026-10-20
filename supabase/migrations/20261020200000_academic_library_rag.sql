-- academic_library_rag
--
-- M6 — Búsqueda de la Biblioteca Académica para el Asistente General. Solo agrega funciones.
--
-- QUÉ CAMBIA
--   1. public.match_academic_chunks(query_embedding vector(768), match_count, p_embedding_model,
--      p_user_id, p_min_similarity): los fragmentos más parecidos a la pregunta, solo de
--      documentos con is_active, status = 'ready', globales (user_id NULL) o del usuario
--      p_user_id, y con embedding_model = p_embedding_model. Rechaza 'legacy-768' y cualquier
--      etiqueta que no sea modelo:dimensión (22023): un vector antiguo nunca se compara con una
--      consulta nueva. Ordena por distancia coseno (la misma de similarity), descarta lo que no
--      llega a p_min_similarity y devuelve como mucho 20 filas, sin título ni ruta: no hay
--      fuentes que mostrar.
--   2. public.academic_library_available(p_embedding_model, p_user_id): si hay al menos un
--      fragmento que la búsqueda podría devolver. /api/chat la consulta antes de pedir el
--      embedding de la pregunta: sin material compatible no se llama a Gemini.
--   Las dos variantes de match_document_chunks NO cambian ni se borran: el código nuevo deja de
--   usarlas y se retiran en una migración posterior.
--
-- SEGURIDAD
--   SECURITY INVOKER y EXECUTE solo para service_role: se revoca de PUBLIC, anon y authenticated
--   (también lo que Supabase concede por defecto a las funciones nuevas de public). /api/chat las
--   llama con service role y con p_user_id resuelto en el servidor (requireUser): el cliente no
--   elige el usuario. Con service role la RLS no aplica, así que el filtro de usuario de la
--   función es la autorización: documentos globales y los del propio usuario, nunca los de otro.
--
-- DEPENDENCIA CON EL CÓDIGO
--   Necesita M4 (is_active, status y embedding_model). El /api/chat de feat/academic-library usa
--   estas funciones: sin M6 su búsqueda falla, no recurre a la RPC antigua y responde sin
--   material. El código anterior no las usa. Hoy no hay fragmentos gemini-embedding-001:768
--   (los 64 son legacy-768): academic_library_available responde false y el asistente contesta
--   con su conocimiento general hasta que se reindexen las guías.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada que use el código actual. create or replace permite reaplicarla.
--
-- CÓMO SE REVIERTE
--   Revertir antes el código que las usa (si no, el chat responde sin material, sin errores
--   visibles para el estudiante) y después:
--     drop function public.match_academic_chunks(extensions.vector, integer, text, uuid, double precision);
--     drop function public.academic_library_available(text, uuid);
--     notify pgrst, 'reload schema';

begin;

create or replace function public.match_academic_chunks(
  query_embedding extensions.vector(768),
  match_count integer,
  p_embedding_model text,
  p_user_id uuid default null,
  p_min_similarity double precision default 0
)
returns table (id bigint, document_id uuid, chunk_index integer, content text, similarity double precision)
language plpgsql
stable
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_embedding_model is null
     or p_embedding_model = 'legacy-768'
     or p_embedding_model !~ '^[a-z0-9][a-z0-9._-]*:[1-9][0-9]*$' then
    raise exception 'match_academic_chunks: modelo de embedding no admitido' using errcode = '22023';
  end if;
  if query_embedding is null or match_count is null or match_count < 1 then
    return;
  end if;

  return query
    select dc.id, dc.document_id, dc.chunk_index, dc.content,
           1 - (dc.embedding <=> query_embedding) as similarity
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    where d.is_active
      and d.status = 'ready'
      and (d.user_id is null or (p_user_id is not null and d.user_id = p_user_id))
      and dc.embedding_model = p_embedding_model
      and dc.embedding is not null
      and 1 - (dc.embedding <=> query_embedding) >= coalesce(p_min_similarity, 0)
    order by dc.embedding <=> query_embedding, dc.id
    limit least(match_count, 20);
end
$$;

create or replace function public.academic_library_available(
  p_embedding_model text,
  p_user_id uuid default null
)
returns boolean
language sql
stable
set search_path = public, extensions, pg_catalog
as $$
  select p_embedding_model is not null
    and p_embedding_model <> 'legacy-768'
    and exists (
      select 1
      from public.document_chunks dc
      join public.documents d on d.id = dc.document_id
      where d.is_active
        and d.status = 'ready'
        and (d.user_id is null or (p_user_id is not null and d.user_id = p_user_id))
        and dc.embedding_model = p_embedding_model
        and dc.embedding is not null
    );
$$;

revoke all on function public.match_academic_chunks(extensions.vector, integer, text, uuid, double precision)
  from public, anon, authenticated;
revoke all on function public.academic_library_available(text, uuid) from public, anon, authenticated;
grant execute on function public.match_academic_chunks(extensions.vector, integer, text, uuid, double precision)
  to service_role;
grant execute on function public.academic_library_available(text, uuid) to service_role;

comment on function public.match_academic_chunks(extensions.vector, integer, text, uuid, double precision) is
  'Biblioteca Académica: fragmentos de documentos activos y listos, globales o del usuario, con el mismo modelo de embedding. Solo service_role.';
comment on function public.academic_library_available(text, uuid) is
  'Biblioteca Académica: si match_academic_chunks tiene material que devolver para ese modelo y usuario. Solo service_role.';

commit;

notify pgrst, 'reload schema';

-- VERIFICACIÓN (solo lectura, después de aplicar):
--
--   select p.oid::regprocedure as funcion, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
--   where n.nspname = 'public' and p.proname in ('match_academic_chunks', 'academic_library_available')
--   order by 1, 2;
--   -- Esperado: execute false para anon y authenticated, true para service_role (2 funciones).
--
--   select public.academic_library_available('gemini-embedding-001:768');
--   -- Esperado hoy (sin guías reindexadas): false.
