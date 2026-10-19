-- Reversión de M3 (20261019005428_student_email_authorizations_calendar_organizer).
-- Fuera de supabase/migrations a propósito: no lo aplica db push. Ejecutar solo a mano y solo
-- después de revertir el código que usa estas tablas.
--
-- Se pierden: las autorizaciones de correos (vuelve a valer solo STUDENT_TEST_EMAIL_ALLOWLIST)
-- y la conexión del organizador. Las invitaciones ya enviadas siguen en Google Calendar: para
-- cancelarlas hay que hacerlo antes, desde la aplicación, o a mano en el calendario
-- organizador. No toca profiles, cohorts ni cohort_events.

begin;

drop table if exists public.calendar_organizer;
drop table if exists public.student_email_authorizations;

drop index if exists public.user_google_calendar_event_map_cohort_event_idx;
alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_organizer_email_format;
alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_last_error_length;
alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_status_check;
alter table public.user_google_calendar_event_map
  drop column if exists last_error,
  drop column if exists last_synced_at,
  drop column if exists content_hash,
  drop column if exists organizer_email,
  drop column if exists status;

grant insert, update, delete, truncate on table
  public.user_google_calendar_event_map,
  public.user_google_calendar_tokens
to authenticated;

commit;

notify pgrst, 'reload schema';
