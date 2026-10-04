-- 20260918100100_plan_tables_readonly_for_authenticated.sql
--
-- FASE 4.2 — Las tablas del plan pasan a solo-lectura para authenticated.
--
-- QUÉ CAMBIA
--   Hoy un estudiante autenticado puede escribir SUS PROPIAS filas de plan_stage_artifacts,
--   plan_stage_states y plan_case_contexts directamente con la anon key, sin pasar por
--   ninguna ruta de la aplicación. Eso deja sin efecto todos los gates de validate: basta
--   un insert de ishikawa_final con status 'validated' y las raíces inventadas para dar una
--   etapa por cerrada, o un update de plan_case_contexts para saltarse hasMinimum
--   (context/confirm/route.ts:101).
--
--   Se quitan INSERT y UPDATE a authenticated en las tres tablas. Los SELECT se conservan
--   (leer lo propio no es el riesgo, y quitarlos no aporta seguridad).
--   No hay policies de DELETE que quitar: plan_stage_artifacts tiene psa_delete_none
--   (qual: false) y plan_stage_states y plan_case_contexts no declaran ninguna, así que con
--   RLS activo el borrado ya está cerrado.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada de la aplicación. Verificado en la Fase 1: el navegador no hace ni un .from() sobre
--   estas tablas; su único uso del cliente anon es supabase.auth.* y una subida a Storage.
--   Toda escritura pasa por rutas de API con service role, que omite RLS
--   (src/lib/plan/stageValidation.ts, activeStage.ts, stageOrchestrator.ts,
--   ishikawaStateStore.ts y src/app/api/plans/**).
--   Si algo del cliente escribiera estas tablas en el futuro, fallaría con
--   "new row violates row-level security policy" (42501) de forma visible, no silenciosa.
--
-- CÓMO SE REVIERTE
--   Volver a crear las cuatro policies con la definición de abajo (están tal cual salen hoy
--   de pg_policies).

begin;

-- plan_stage_artifacts
drop policy if exists psa_insert_own on public.plan_stage_artifacts;
drop policy if exists psa_update_own on public.plan_stage_artifacts;

-- plan_stage_states
drop policy if exists plan_stage_states_insert_own on public.plan_stage_states;
drop policy if exists plan_stage_states_update_own on public.plan_stage_states;

-- plan_case_contexts
drop policy if exists pcc_insert_own on public.plan_case_contexts;
drop policy if exists pcc_update_own on public.plan_case_contexts;

commit;

-- REVERSIÓN EXACTA (copiar y ejecutar si hiciera falta):
--
--   create policy psa_insert_own on public.plan_stage_artifacts
--     for insert to authenticated
--     with check (user_id = (auth.uid())::text);
--
--   create policy psa_update_own on public.plan_stage_artifacts
--     for update to authenticated
--     using (user_id = (auth.uid())::text)
--     with check (user_id = (auth.uid())::text);
--
--   create policy plan_stage_states_insert_own on public.plan_stage_states
--     for insert to authenticated
--     with check (auth.uid() = user_id);
--
--   create policy plan_stage_states_update_own on public.plan_stage_states
--     for update to authenticated
--     using (auth.uid() = user_id)
--     with check (auth.uid() = user_id);
--
--   create policy pcc_insert_own on public.plan_case_contexts
--     for insert to authenticated
--     with check (user_id = (auth.uid())::text);
--
--   create policy pcc_update_own on public.plan_case_contexts
--     for update to authenticated
--     using (user_id = (auth.uid())::text)
--     with check (user_id = (auth.uid())::text);
