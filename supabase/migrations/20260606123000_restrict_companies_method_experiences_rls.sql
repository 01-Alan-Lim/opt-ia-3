-- =============================================================================
-- Migración: restringir RLS de SELECT en public.companies y
--            public.method_engineering_experiences.
-- Rama:      fix/rls-companies-method-experiences
-- Fecha:     2026-06-06
-- =============================================================================
--
-- CONTEXTO / POR QUÉ
-- -----------------------------------------------------------------------------
-- La auditoría detectó políticas SELECT "abiertas" sobre dos tablas con datos
-- sensibles (razón social real de empresas, productos, causas en texto libre):
--
--   public.companies
--     - companies_select_authenticated : SELECT, role=authenticated, qual = true
--   public.method_engineering_experiences
--     - mee_select_authenticated        : SELECT, role=authenticated, qual = true
--
-- Con qual = true, CUALQUIER usuario autenticado (incluidos los estudiantes)
-- puede ejecutar desde el navegador, con el cliente anon + su sesión Supabase:
--     supabase.from('companies').select('*')
--     supabase.from('method_engineering_experiences').select('*')
-- y leer TODAS las columnas, incluyendo las sensibles. Esto evita por completo
-- la anonimización por columnas (SAFE_COLUMNS) y el aliasing ("Empresa C-01")
-- que hacen los endpoints server-side /api/companies y /api/method-experiences.
--
-- POR QUÉ ES SEGURO RESTRINGIR (no rompe la app)
-- -----------------------------------------------------------------------------
-- Ningún flujo de la app depende del SELECT directo como `authenticated`:
--   * /api/chat lee ambas tablas con el cliente service_role (supabaseServer),
--     que tiene BYPASSRLS=true -> IGNORA estas políticas. No se ve afectado.
--   * /api/companies y /api/method-experiences usan el cliente anon
--     (NEXT_PUBLIC_SUPABASE_ANON_KEY) en el servidor. El rol `anon` NO tiene
--     GRANT sobre estas tablas (has_table_privilege('anon', ..., 'SELECT')=false)
--     ni política propia, por lo que su comportamiento NO cambia con esta
--     migración (depende del GRANT, no de estas políticas de `authenticated`).
--   * No existe en el repo ningún uso de .from('companies') ni
--     .from('method_engineering_experiences') desde componentes de navegador
--     (supabaseBrowser). Todo el consumo de datos pasa por endpoints server.
--
-- QUÉ CAMBIA
-- -----------------------------------------------------------------------------
-- Se elimina el SELECT abierto a `authenticated` (qual = true) y se reemplaza
-- por un SELECT restringido SOLO a docentes, replicando exactamente el patrón
-- ya usado por la política `profiles_select_teacher_all` de public.profiles:
--     EXISTS (SELECT 1 FROM profiles p
--             WHERE p.user_id = (auth.uid())::text AND p.role = 'teacher')
-- Los estudiantes (authenticated sin role='teacher') dejan de poder hacer
-- SELECT directo: al no coincidir ninguna política, RLS devuelve 0 filas.
--
-- NO SE TOCA INSERT/UPDATE/DELETE: ya están bloqueados con qual/with_check=false
-- (companies_insert_none, companies_update_none, companies_delete_none,
--  mee_write_none_ins, mee_write_none_upd, mee_write_none_del) y se conservan.
--
-- QUÉ SE ROMPE SI NO SE HACE
-- -----------------------------------------------------------------------------
-- Si NO se aplica, cualquier estudiante autenticado puede leer directamente
-- desde el navegador la totalidad de ambas tablas (razón social real de las
-- empresas y datos sensibles de cada experiencia), saltándose la anonimización
-- de los endpoints. Es una fuga de datos sensibles.
--
-- NOTAS
-- -----------------------------------------------------------------------------
--   * RLS ya está habilitada en ambas tablas (relrowsecurity = true).
--   * El rol BI `looker_reader` tiene GRANT SELECT directo pero BYPASSRLS=false
--     y NINGUNA política: hoy ya no ve filas vía RLS. Esta migración no cambia
--     su situación (no se tocan sus GRANTs ni se le crean políticas).
--   * El predicado envuelve `auth.uid()` como `(select auth.uid())::text`
--     (initplan): Postgres lo evalúa UNA vez por consulta en lugar de por fila,
--     optimizando el plan frente a `auth.uid()::text` directo. Mismo resultado
--     lógico que el patrón de profiles_select_teacher_all.
--   * Idempotente: se usa `drop policy if exists` con los nombres EXACTOS y se
--     re-crea la política de docente tras borrarla, para poder re-ejecutar.
--   * No se crean vistas en esta migración.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) public.companies
-- -----------------------------------------------------------------------------

-- 1.a) Eliminar el SELECT abierto a authenticated (qual = true).
drop policy if exists "companies_select_authenticated" on public.companies;

-- 1.b) Reemplazo: SELECT directo permitido SOLO a docentes.
drop policy if exists "companies_select_teacher" on public.companies;
create policy "companies_select_teacher"
  on public.companies
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = (select auth.uid())::text
        and p.role = 'teacher'
    )
  );

-- -----------------------------------------------------------------------------
-- 2) public.method_engineering_experiences
-- -----------------------------------------------------------------------------

-- 2.a) Eliminar el SELECT abierto a authenticated (qual = true).
drop policy if exists "mee_select_authenticated" on public.method_engineering_experiences;

-- 2.b) Reemplazo: SELECT directo permitido SOLO a docentes.
drop policy if exists "mee_select_teacher" on public.method_engineering_experiences;
create policy "mee_select_teacher"
  on public.method_engineering_experiences
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = (select auth.uid())::text
        and p.role = 'teacher'
    )
  );

-- =============================================================================
-- FIN DE LA MIGRACIÓN
-- =============================================================================
