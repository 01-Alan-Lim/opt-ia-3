-- 20260918100000_profiles_update_own_column_scope.sql
--
-- FASE 4.1 — Un estudiante no puede escribir su perfil directamente: ni cambiarse el rol,
-- ni aprobarse, ni cambiarse de cohorte o de ventana de acceso, ni crearse una fila.
--
-- QUÉ CAMBIA
--   Hoy authenticated tiene INSERT y UPDATE sobre toda la tabla (no hay grants por columna),
--   y las dos policies que los habilitan solo acotan la FILA, no las columnas:
--     profiles_update_own  UPDATE  using y check: user_id = (auth.uid())::text
--     profiles_insert_own  INSERT  check:         user_id = (auth.uid())::text
--   Con la anon key y su sesión, un estudiante puede hacer
--       update profiles set role = 'teacher', registration_status = 'approved',
--              cohort_id = ..., access_ends_at = ... where user_id = auth.uid();
--   y una cuenta que todavía no tiene fila (15 en auth.users al 2026-10-04) puede
--   insertarse una con esos mismos valores. role = 'teacher' abre 6 policies:
--   profiles_select_teacher_all (correos, RU y nombres de todo el padrón),
--   cohorts_select_teacher_all, companies_select_teacher, mee_select_teacher,
--   hours_select_teacher y cohort_events_teacher_write (cmd ALL sobre el calendario de
--   cualquier cohorte). registration_status, cohort_id y access_* son además lo que lee el
--   gate de acceso (src/lib/auth/chatAccess.ts): cambiarlos salta la aprobación, la cohorte
--   inactiva y la ventana de acceso.
--
--   Se quitan a authenticated el INSERT y el UPDATE, y se borra profiles_insert_own.
--   No se devuelve UPDATE en ninguna columna. Verificado en el código (2026-10-04):
--     - Ningún código del navegador escribe profiles (solo usa supabase.auth.*). Las cuatro
--       escrituras son rutas de servidor con service role, que omite RLS y grants:
--         api/auth/after-login          upsert de user_id, email y role
--         api/onboarding/submit         upsert de los datos del estudiante
--         api/teacher/students/approve  update de registration_status
--         api/teacher/cohorts/[id]      update de los perfiles de una cohorte
--     - Los datos que llena el estudiante (ru, first_name, last_name, semester,
--       company_name) se escriben solo por api/onboarding/submit, que los valida
--       (SubmitSchema: RU de 5 a 10 dígitos, nombres de 2 a 60, empresa de 2 a 120) y deja
--       registration_status en 'pending': cambiar la identidad exige otra aprobación del
--       docente. Un UPDATE directo, aunque fuera por columna, saltaría esa validación y esa
--       re-aprobación (por ejemplo, cambiar el RU después de aprobado).
--     - cohort_id es autoridad: onboarding/submit lo fija tras comprobar que la cohorte está
--       activa y con el registro abierto.
--   Si algún día el estudiante debe editar su perfil desde la aplicación, que sea por una ruta
--   de servidor que valide, no reabriendo este grant.
--
--   No cambia: el SELECT (profiles_select_own y profiles_select_teacher_all), service_role,
--   el acceso docente ni la policy profiles_update_own, que sin grant de UPDATE queda sin
--   efecto y se conserva por si un día se concede UPDATE por columna. DELETE ya está cerrado:
--   RLS activo y ninguna policy de DELETE. Los grants de anon los quita 20260918100400.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada de la aplicación: todo pasa por service role. Si un cliente intentara escribir
--   profiles con su sesión, recibiría "permission denied for table profiles" (42501), un
--   fallo visible, no silencioso.
--
-- CÓMO SE REVIERTE
--   grant insert, update on public.profiles to authenticated;
--   create policy profiles_insert_own on public.profiles
--     for insert to authenticated
--     with check (user_id = (auth.uid())::text);

begin;

-- Revocar a nivel de tabla quita también los privilegios por columna del mismo tipo (hoy
-- no hay ninguno), así que no queda INSERT ni UPDATE en ninguna columna.
revoke insert, update on public.profiles from authenticated;

drop policy if exists profiles_insert_own on public.profiles;

commit;

-- Verificación posterior (solo lectura):
--   1) authenticated sin INSERT ni UPDATE en la tabla ni en ninguna columna; SELECT intacto.
--      Esperado: false, false, true.
--        select has_any_column_privilege('authenticated', 'public.profiles', 'UPDATE') as auth_update,
--               has_any_column_privilege('authenticated', 'public.profiles', 'INSERT') as auth_insert,
--               has_table_privilege('authenticated', 'public.profiles', 'SELECT')      as auth_select;
--   2) service_role sigue escribiendo. Esperado: true, true.
--        select has_table_privilege('service_role', 'public.profiles', 'INSERT') as sr_insert,
--               has_table_privilege('service_role', 'public.profiles', 'UPDATE') as sr_update;
--   3) Policies: ya no está profiles_insert_own; siguen profiles_select_own,
--      profiles_select_teacher_all y profiles_update_own.
--        select policyname, cmd from pg_policies
--        where schemaname = 'public' and tablename = 'profiles'
--        order by policyname;
