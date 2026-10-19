-- Verificación de M3 (20261019005428_student_email_authorizations_calendar_organizer). SOLO LECTURA.
-- Fuera de supabase/migrations a propósito: no lo aplica db push.

-- 1) Esquema: cada fila trae ok = true si la comprobación pasa.
select 'table_' || c.relname as item, c.relrowsecurity as ok, 'rls=' || c.relrowsecurity as detail
from pg_class c
where c.oid in ('public.student_email_authorizations'::regclass, 'public.calendar_organizer'::regclass)
union all
select 'no_grants_' || c.relname,
       not exists (
         select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where a.grantee::regrole::text in ('anon', 'authenticated')
       ),
       coalesce(array_to_string(c.relacl, ' '), '')
from pg_class c
where c.oid in ('public.student_email_authorizations'::regclass, 'public.calendar_organizer'::regclass)
union all
select 'active_email_index', indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%WHERE (revoked_at IS NULL)%', indexdef
from pg_indexes where schemaname = 'public' and indexname = 'student_email_authorizations_active_email_key'
union all
select 'event_map_col_' || column_name, true, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'user_google_calendar_event_map'
  and column_name in ('status', 'organizer_email', 'content_hash', 'last_synced_at', 'last_error')
union all
select 'authenticated_no_write_' || t.relname || '_' || p.priv,
       not has_table_privilege('authenticated', t.oid, p.priv),
       p.priv
from pg_class t
cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
where t.oid in ('public.user_google_calendar_event_map'::regclass, 'public.user_google_calendar_tokens'::regclass);
-- Esperado: 2 + 2 + 1 + 5 + 8 = 18 filas, todas ok = true.

-- 2) Transición: autorizaciones heredadas frente a estudiantes no institucionales existentes.
select
  (select count(*) from public.student_email_authorizations where revoked_at is null) as active_authorizations,
  (select count(distinct lower(btrim(email))) from public.profiles
     where role = 'student' and registration_status in ('approved', 'pending')
       and email is not null and lower(btrim(email)) not like '%@umsa.bo') as legacy_students;
-- Esperado justo después de aplicar: active_authorizations = legacy_students (hoy, 5).

-- 3) Nada más cambió.
select role, registration_status, count(*) from public.profiles group by 1, 2 order by 1, 2;
select count(*) as calendar_organizer_rows from public.calendar_organizer;          -- 0
select count(*) as event_map_rows from public.user_google_calendar_event_map;       -- 0
