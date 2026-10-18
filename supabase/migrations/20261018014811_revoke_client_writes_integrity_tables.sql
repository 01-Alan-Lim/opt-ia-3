-- revoke_client_writes_integrity_tables
--
-- M1 — Retirar la escritura directa de authenticated en las tablas de integridad académica.
--
-- QUÉ CAMBIA
--   En hours_entries, messages, chats, plan_reviews e improvement_plans el rol authenticated
--   tiene arwdDxtm, concedido por postgres. Con la anon key (pública) y su propio token, un
--   estudiante puede escribir en estas tablas directamente contra PostgREST, sin pasar por
--   las rutas /api/*. RLS solo exige que la fila sea suya, y eso alcanza para:
--     - hours_entries: insertar semanas pasadas o futuras y editar horas, actividad o cohorte
--       de sus registros (policies hours_insert_student y hours_update_own).
--     - messages: insertar o reescribir mensajes de sus chats, incluidas las respuestas del
--       asistente (messages_insert_own_chat y messages_update_own_chat).
--     - chats, plan_reviews e improvement_plans: crear o editar sus filas, incluidas las
--       revisiones con reviewer_type = 'ai'.
--   Se retiran INSERT, UPDATE, DELETE y TRUNCATE a authenticated en las cinco. TRUNCATE no
--   pasa por RLS, por eso entra también. Queda authenticated = rxtm: SELECT se conserva y las
--   policies de lectura siguen filtrando por dueño. No se toca ninguna policy; las de
--   escritura quedan sin efecto mientras no haya grant y se pueden limpiar aparte.
--   No cubre /api/messages, que sigue aceptando role = 'assistant' enviado por el navegador:
--   eso necesita un cambio de código, no de permisos.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada en la app actual (main 8ae78ad e integración bba24e5): todas las escrituras en estas
--   tablas las hacen rutas de servidor con supabaseServer (service role, con BYPASSRLS y
--   grants propios que no cambian). Ningún componente del navegador escribe en ellas, ninguna
--   función ni RPC lo hace, Realtime no publica ninguna y authenticated no hereda grants de
--   otro rol. Lo que intentara escribir como authenticated fallaría con 42501.
--
-- CÓMO SE REVIERTE
--   grant insert, update, delete, truncate on table
--     public.hours_entries, public.messages, public.chats,
--     public.plan_reviews, public.improvement_plans
--   to authenticated;
--   Ejecutado como postgres, deja otra vez authenticated = arwdDxtm/postgres.

begin;

revoke insert, update, delete, truncate on table
  public.hours_entries,
  public.messages,
  public.chats,
  public.plan_reviews,
  public.improvement_plans
from authenticated;

commit;

-- Verificación posterior (solo lectura): la consulta debe devolver 0 filas.
--   select c.relname, p.priv
--   from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--     cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
--   where n.nspname = 'public'
--     and c.relname in ('hours_entries', 'messages', 'chats', 'plan_reviews', 'improvement_plans')
--     and has_table_privilege('authenticated', c.oid, p.priv);
