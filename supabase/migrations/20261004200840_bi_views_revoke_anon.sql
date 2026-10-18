-- 20260918100300_bi_views_revoke_anon.sql
--
-- FASE 4.4 — Las 7 views BI dejan de ser legibles por la API pública: ni con la anon key
-- ni con la sesión de un usuario. (El nombre del archivo dice "anon" por historia: también
-- revoca a authenticated.)
--
-- QUÉ CAMBIA
--   Las 7 views que el linter marca como SECURITY DEFINER (sin security_invoker; su dueño es
--   postgres, que también es dueño de las tablas, así que dentro de ellas no se aplica la
--   RLS) tienen hoy todos los privilegios (arwdDxtm) para anon Y para authenticated.
--   Exponen, por student_id/user_id, los datos de TODOS los estudiantes:
--     v_bi_stage_activity      student_id, cohort_id, chat_id, stage, artifact_type, status…
--     v_bi_stage_scores        student_id, cohort_id, stage, total_score, total_label…
--     v_bi_stage_scores_v2     idem
--     v_bi_usage_daily         student_id, cohort_id, día, mensajes, última actividad
--     v_student_score          user_id, avg_score, evals_total
--     v_student_stage_progress user_id, stages_worked, artifacts_total, artifacts_validated
--     v_student_usage          user_id, mensajes, primera y última actividad
--   Con anon basta la NEXT_PUBLIC_SUPABASE_ANON_KEY (va en el bundle del navegador). Con
--   authenticated basta además una sesión, de cualquier cuenta que pueda iniciar sesión: el
--   filtro de dominio institucional vive en requireUser (servidor), no en la RLS.
--   Se revoca TODO el privilegio de anon y de authenticated sobre las 7.
--
--   Esta migración solo toca GRANTS. SECURITY DEFINER SE CONSERVA a propósito: las views
--   leen tablas con RLS activo y looker_reader no tiene policies propias, así que con
--   SECURITY INVOKER recibiría cero filas y el informe de Looker Studio se quedaría en
--   blanco. El problema nunca fue el SECURITY DEFINER sino los grants a anon y authenticated.
--
--   No se tocan (verificado en la base, 2026-10-04):
--     looker_reader            SELECT en las 7. Es un rol LOGIN, sin BYPASSRLS, que no es
--                              miembro de anon ni de authenticated: su acceso es por grant
--                              directo y no depende de lo que se revoca aquí.
--     postgres                 dueño de las views.
--     service_role             ninguna ruta de servidor consulta estas views.
--     supabase_read_only_user  SELECT en v_bi_stage_scores_v2 (rol de solo lectura).
--   Las 4 views v_hours_* NO están aquí: son security_invoker y authenticated solo tiene
--   SELECT, con la RLS de las tablas aplicada.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada de la aplicación: ninguna ruta de servidor, componente ni script consulta estas
--   views (grep de v_bi_ / v_student_ en el repo, fuera de supabase/migrations, da vacío).
--   El panel docente solo incrusta el informe de Looker en un iframe
--   (components/teacher/TeacherDashboard.tsx).
--   Una conexión directa de Looker no puede depender de anon ni de authenticated: los dos
--   son roles NOLOGIN. Si el informe quedara vacío después de aplicar esto, habría que
--   revisar con qué usuario está configurado el data source; el acceso de looker_reader no
--   cambia.
--
-- CÓMO SE REVIERTE
--   grant select on <cada view> to anon, authenticated;   -- y, si de verdad hiciera
--                                                          -- falta, el resto de
--                                                          -- privilegios, que nunca se usaron.

begin;

revoke all on public.v_bi_stage_activity      from anon, authenticated;
revoke all on public.v_bi_stage_scores        from anon, authenticated;
revoke all on public.v_bi_stage_scores_v2     from anon, authenticated;
revoke all on public.v_bi_usage_daily         from anon, authenticated;
revoke all on public.v_student_score          from anon, authenticated;
revoke all on public.v_student_stage_progress from anon, authenticated;
revoke all on public.v_student_usage          from anon, authenticated;

commit;

-- Verificación posterior (solo lectura): anon y authenticated sin ningún privilegio,
-- looker_reader con SELECT. Esperado en las 7 filas: false, false, true.
--   select c.relname,
--          has_table_privilege('anon', c.oid,
--            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon_alguno,
--          has_table_privilege('authenticated', c.oid,
--            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as authenticated_alguno,
--          case when exists (select 1 from pg_roles where rolname = 'looker_reader')
--               then has_table_privilege('looker_reader', c.oid, 'SELECT') end   as looker_select
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public'
--     and c.relname in ('v_bi_stage_activity','v_bi_stage_scores','v_bi_stage_scores_v2',
--                       'v_bi_usage_daily','v_student_score','v_student_stage_progress',
--                       'v_student_usage')
--   order by c.relname;
