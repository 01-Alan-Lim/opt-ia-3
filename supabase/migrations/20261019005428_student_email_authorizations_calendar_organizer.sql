-- student_email_authorizations_calendar_organizer
--
-- M3 — Correos autorizados por docentes y calendario organizador de OPT-IA.
--
-- QUÉ CAMBIA
--   1. public.student_email_authorizations (nueva): correos personales (p. ej. Gmail) que un
--      docente autoriza a entrar como estudiantes. Autorizar NO aprueba académicamente: el
--      estudiante sigue pasando por onboarding y aprobación docente. Un correo tiene a lo sumo
--      una autorización activa (índice único parcial). Una fila revocada sin otra activa deja al
--      correo sin acceso aunque siga en STUDENT_TEST_EMAIL_ALLOWLIST: la revocación manda.
--      Se cargan como activas las de los estudiantes no institucionales que ya existen
--      (aprobados o pendientes), para que nadie pierda el acceso en la transición. Los datos
--      salen de profiles: el repositorio no contiene ningún correo.
--   2. public.calendar_organizer (nueva, una sola fila): la cuenta de Google que envía las
--      invitaciones. El refresh token se guarda cifrado por la aplicación (AES-256-GCM, clave
--      CALENDAR_TOKEN_ENCRYPTION_KEY); la base nunca ve el token en claro.
--   3. public.user_google_calendar_event_map (existente, 0 filas): pasa a registrar las
--      invitaciones del organizador, una por estudiante y evento de cohorte (unicidad
--      user_id + cohort_event_id que ya tenía). Columnas nuevas: status, organizer_email (la
--      cuenta que envió la invitación: solo ella puede actualizarla o cancelarla), content_hash,
--      last_synced_at y last_error.
--   4. Permisos: las tablas nuevas, sin RLS policies y sin grants para anon/authenticated
--      (solo service_role, desde rutas de servidor). En user_google_calendar_event_map y
--      user_google_calendar_tokens se retira la escritura de authenticated: ahora las
--      gestiona solo el servidor (antes un estudiante podía editar su propio mapeo).
--
-- DEPENDENCIA CON EL CÓDIGO
--   El código nuevo lee estas tablas. Si student_email_authorizations todavía no existe,
--   requireUser vuelve a STUDENT_TEST_EMAIL_ALLOWLIST (nadie queda fuera); las rutas de
--   correos autorizados y del organizador responden con error hasta aplicar M3. El código
--   anterior (main) no usa nada de esto y sigue funcionando con M3 aplicada.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Un cliente que escribiera directamente en user_google_calendar_tokens o en
--   user_google_calendar_event_map con la sesión del estudiante fallaría con 42501. Ninguno lo
--   hace: las dos tablas están vacías y el flujo por estudiante se retira en esta versión.
--
-- CÓMO SE REVIERTE
--   supabase/manual/20261018230000_m3_rollback.sql (pierde autorizaciones y conexión del
--   organizador; no toca profiles ni cohort_events).

begin;

-- 1) Correos autorizados ---------------------------------------------------------------

create table if not exists public.student_email_authorizations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  note text,
  authorized_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  constraint student_email_authorizations_email_format check (
    email = lower(btrim(email))
    and char_length(email) <= 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint student_email_authorizations_note_length check (note is null or char_length(note) <= 200),
  constraint student_email_authorizations_revoked_by_needs_revoked_at check (revoked_by is null or revoked_at is not null)
);

create unique index if not exists student_email_authorizations_active_email_key
  on public.student_email_authorizations (email)
  where revoked_at is null;

create index if not exists student_email_authorizations_email_idx
  on public.student_email_authorizations (email, created_at desc);

alter table public.student_email_authorizations enable row level security;
revoke all on table public.student_email_authorizations from anon, authenticated;

-- Transición: los estudiantes no institucionales que ya entraron (aprobados o pendientes)
-- quedan autorizados. Solo si no tienen ya una fila (activa o revocada).
insert into public.student_email_authorizations (email, note)
select distinct lower(btrim(p.email)), 'Autorización heredada (estudiante existente antes de M3)'
from public.profiles p
where p.role = 'student'
  and p.registration_status in ('approved', 'pending')
  and p.email is not null
  and lower(btrim(p.email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  and lower(btrim(p.email)) not like '%@umsa.bo'
  and not exists (
    select 1 from public.student_email_authorizations a where a.email = lower(btrim(p.email))
  );

-- 2) Calendario organizador ------------------------------------------------------------

create table if not exists public.calendar_organizer (
  id boolean primary key default true,
  google_email text not null,
  calendar_id text not null default 'primary',
  refresh_token_ciphertext text not null,
  scope text,
  status text not null default 'connected',
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint calendar_organizer_singleton check (id),
  constraint calendar_organizer_status_check check (status in ('connected', 'disconnected')),
  constraint calendar_organizer_ciphertext_format check (refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  constraint calendar_organizer_last_error_length check (last_error is null or char_length(last_error) <= 300)
);

alter table public.calendar_organizer enable row level security;
revoke all on table public.calendar_organizer from anon, authenticated;

-- 3) Invitaciones del organizador --------------------------------------------------------

alter table public.user_google_calendar_event_map
  add column if not exists status text not null default 'invited',
  add column if not exists organizer_email text,
  add column if not exists content_hash text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_error text;

alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_status_check;
alter table public.user_google_calendar_event_map
  add constraint user_google_calendar_event_map_status_check check (status in ('invited', 'cancelled'));

alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_last_error_length;
alter table public.user_google_calendar_event_map
  add constraint user_google_calendar_event_map_last_error_length check (last_error is null or char_length(last_error) <= 300);

alter table public.user_google_calendar_event_map drop constraint if exists user_google_calendar_event_map_organizer_email_format;
alter table public.user_google_calendar_event_map
  add constraint user_google_calendar_event_map_organizer_email_format check (organizer_email is null or organizer_email = lower(btrim(organizer_email)));

create index if not exists user_google_calendar_event_map_cohort_event_idx
  on public.user_google_calendar_event_map (cohort_event_id);

-- 4) El servidor gestiona las tablas de Calendar -----------------------------------------

revoke insert, update, delete, truncate on table
  public.user_google_calendar_event_map,
  public.user_google_calendar_tokens
from authenticated;

commit;

notify pgrst, 'reload schema';

-- Verificación posterior (solo lectura): supabase/manual/20261018230000_m3_verify.sql
