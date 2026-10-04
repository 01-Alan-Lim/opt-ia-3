-- 20260918100400_revoke_broad_anon_grants.sql
--
-- FASE 4.5 — Limpiar los grants amplios a anon.
--
-- QUÉ CAMBIA
--   Diez tablas (no nueve: lo conté mal en el informe de la Fase 1, lo corrijo aquí) tienen
--   anon = arwdDxtm, es decir SELECT/INSERT/UPDATE/DELETE y más para el rol anónimo:
--     cohort_events, cohorts, hours_entries, plan_case_contexts, plan_stage_artifacts,
--     plan_stage_evaluations, plan_stage_states, profiles,
--     user_google_calendar_event_map, user_google_calendar_tokens
--   Hoy están neutralizadas por RLS: todas tienen rowsecurity activo y ninguna policy
--   nombra a anon, así que el rol anónimo no ve ni escribe nada. Pero es permiso que nadie
--   necesita, y el día que alguien cree una policy con `to public` deja de estar contenido.
--   Se revoca todo lo de anon en las diez.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada hoy: ninguna ruta ni componente entra como anon a estas tablas. El cliente del
--   navegador usa la anon key solo para supabase.auth.*; en cuanto hay sesión, PostgREST
--   actúa como authenticated, no como anon. Las rutas de servidor usan service role.
--   El caso a vigilar sería una pantalla pública que leyera cohorts sin sesión: no existe
--   (api/cohorts/active/route.ts exige requireUser).
--
-- CÓMO SE REVIERTE
--   grant all on <tabla> to anon;   -- por cada una de las diez.

begin;

revoke all on public.cohort_events                   from anon;
revoke all on public.cohorts                         from anon;
revoke all on public.hours_entries                   from anon;
revoke all on public.plan_case_contexts              from anon;
revoke all on public.plan_stage_artifacts            from anon;
revoke all on public.plan_stage_evaluations          from anon;
revoke all on public.plan_stage_states               from anon;
revoke all on public.profiles                        from anon;
revoke all on public.user_google_calendar_event_map  from anon;
revoke all on public.user_google_calendar_tokens     from anon;

commit;

-- Verificación posterior (solo lectura): la consulta debe devolver 0 filas.
--   select c.relname
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--     and (has_table_privilege('anon', c.oid, 'SELECT')
--       or has_table_privilege('anon', c.oid, 'INSERT')
--       or has_table_privilege('anon', c.oid, 'UPDATE')
--       or has_table_privilege('anon', c.oid, 'DELETE'));
