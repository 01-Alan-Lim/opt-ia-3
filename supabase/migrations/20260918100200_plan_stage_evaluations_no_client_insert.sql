-- 20260918100200_plan_stage_evaluations_no_client_insert.sql
--
-- FASE 4.3 — El estudiante deja de poder insertar su propia calificación.
--
-- QUÉ CAMBIA
--   La policy "insert own stage evaluations" permite a authenticated insertar filas en
--   plan_stage_evaluations con auth.uid() = user_id. Esa tabla es la que alimenta las notas
--   de las views BI (v_bi_stage_scores, v_student_score): un estudiante puede escribirse
--   total_score 100 en cualquier etapa.
--   Se quita el INSERT. Se conserva "select own stage evaluations" para que pueda seguir
--   viendo su propia evaluación.
--   No hay policies de UPDATE ni DELETE en esta tabla, así que quedan cerradas por RLS.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada de la aplicación: las evaluaciones las inserta cada validate con service role
--   (foda/validate:241, brainstorm/validate:304, ishikawa/validate:437, pareto/validate:401,
--   objectives/validate:376, improvement/validate:463, planning/validate:319,
--   progress/validate:248, final_doc/validate:228, productivity/validate:269).
--   El cliente nunca escribe esta tabla.
--
-- CÓMO SE REVIERTE
--   create policy "insert own stage evaluations" on public.plan_stage_evaluations
--     for insert to authenticated
--     with check (auth.uid() = user_id);

begin;

drop policy if exists "insert own stage evaluations" on public.plan_stage_evaluations;

commit;
