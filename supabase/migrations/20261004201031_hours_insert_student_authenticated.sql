-- 20260918100500_hours_insert_student_authenticated.sql
--
-- FASE 4.6 — hours_insert_student: {public} -> {authenticated}.
--
-- QUÉ CAMBIA
--   La policy hours_insert_student está declarada `to public`, y PUBLIC incluye a anon.
--   Hoy NO es explotable, porque su with_check exige auth.uid() = user_id y para anon
--   auth.uid() es null, así que la comprobación nunca pasa. Es una declaración incorrecta,
--   no un agujero abierto. Se corrige para que diga lo que quiere decir.
--   La condición del with_check se conserva íntegra: mismo usuario, perfil aprobado,
--   cohorte activa, ventana de acceso vigente y cohorte coincidente.
--
--   Nota: la policy tampoco la usa la aplicación. /api/hours inserta con service role
--   (api/hours/route.ts:228-230). Se deja viva por si en el futuro se escribe desde el
--   cliente; si se decide lo contrario, se puede borrar entera.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Nada: ningún flujo inserta horas como anon, y el registro de horas del estudiante pasa
--   por /api/hours con service role. Si algo dependiera de insertar sin sesión, fallaría
--   con 42501, pero ese caso no existe y además hoy ya fallaría por el with_check.
--
-- CÓMO SE REVIERTE
--   Volver a crearla con `to public` en lugar de `to authenticated`, con el mismo
--   with_check de abajo.

begin;

drop policy if exists hours_insert_student on public.hours_entries;

create policy hours_insert_student on public.hours_entries
  for insert to authenticated
  with check (
    (auth.uid() = user_id)
    and exists (
      select 1
      from public.profiles p
        join public.cohorts c on c.id = p.cohort_id
      where p.user_id = (auth.uid())::text
        and p.registration_status = 'approved'
        and c.is_active = true
        and (p.access_starts_at is null or now() >= p.access_starts_at)
        and (p.access_ends_at is null or now() <= p.access_ends_at)
        and hours_entries.cohort_id = p.cohort_id
    )
  );

commit;
