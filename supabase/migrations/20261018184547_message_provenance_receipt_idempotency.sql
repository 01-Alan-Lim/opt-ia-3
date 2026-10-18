-- message_provenance_receipt_idempotency
--
-- M2 — Procedencia de los mensajes e idempotencia de recibos (cierre de R1).
--
-- QUÉ CAMBIA (solo en public.messages)
--   1. role admite 'advisor' y deja de admitir 'system':
--        messages_role_check: role in ('user', 'assistant', 'advisor').
--      advisor = texto local del asesor generado en el navegador (guías, transiciones,
--      validaciones, reanudaciones, E0). Se conserva en el historial sin atribuirlo a la IA.
--      system no lo escribe ningún código y hoy hay 0 filas: deja de ser válido.
--   2. receipt_nonce text: nonce del recibo con el que /api/messages verificó una respuesta
--      assistant. Único en toda la tabla (messages_receipt_nonce_key): un recibo solo puede
--      producir una fila, aunque llegue repetido, concurrente o desde varias instancias. Solo
--      puede tenerlo una fila assistant, con el formato del nonce del recibo.
--   3. client_message_id uuid: clave de idempotencia que manda el navegador para user y
--      advisor. Única por chat (messages_chat_client_message_id_key): un reintento del mismo
--      mensaje no lo duplica.
--   Nada se reclasifica: las filas existentes quedan iguales, con las columnas nuevas en NULL.
--   Las assistant sin receipt_nonce son las históricas o las que escriben rutas de servidor
--   (/api/chat, /api/plans/review).
--
-- DEPENDENCIA CON EL CÓDIGO
--   El código del release (POST /api/messages) escribe role 'advisor', receipt_nonce y
--   client_message_id: necesita esta migración. Sin ella responde 503 SCHEMA_NOT_READY y no
--   guarda nada (no hay escrituras parciales ni silenciosas).
--   El código anterior (main) no usa nada de esto y sigue funcionando con la migración
--   aplicada: inserta user/assistant sin las columnas nuevas y lee id, role, content y
--   created_at. Por eso el orden es: aplicar M2, verificar, y después desplegar el código.
--
-- VISTAS
--   v_student_usage y v_bi_usage_daily no cambian. messages_total incluye las filas advisor;
--   messages_assistant cuenta solo role = 'assistant', así que desde el despliegue deja de
--   contar los textos locales del asesor.
--
-- QUÉ SE ROMPE SI ME EQUIVOCO
--   Un escritor que todavía usara role 'system' fallaría con 23514 (no existe ninguno en el
--   código ni en funciones o triggers de la base). Las operaciones toman bloqueos breves sobre
--   messages (unas 15 mil filas): validar el CHECK y crear dos índices parciales.
--
-- CÓMO SE REVIERTE
--   Preferible: revertir solo el código. La migración es compatible con el código anterior.
--   Reversión completa: supabase/manual/20261018160000_m2_rollback.sql (se niega a correr si
--   ya hay filas advisor, porque devolverlas a assistant las atribuiría a la IA).

begin;

alter table public.messages drop constraint if exists messages_role_check;
alter table public.messages
  add constraint messages_role_check check (role in ('user', 'assistant', 'advisor'));

alter table public.messages add column if not exists receipt_nonce text;
alter table public.messages add column if not exists client_message_id uuid;

alter table public.messages drop constraint if exists messages_receipt_nonce_format;
alter table public.messages
  add constraint messages_receipt_nonce_format
  check (receipt_nonce is null or receipt_nonce ~ '^[A-Za-z0-9_-]{16,64}$');

alter table public.messages drop constraint if exists messages_receipt_nonce_assistant_only;
alter table public.messages
  add constraint messages_receipt_nonce_assistant_only
  check (receipt_nonce is null or role = 'assistant');

create unique index if not exists messages_receipt_nonce_key
  on public.messages (receipt_nonce)
  where receipt_nonce is not null;

create unique index if not exists messages_chat_client_message_id_key
  on public.messages (chat_id, client_message_id)
  where client_message_id is not null;

comment on column public.messages.receipt_nonce is
  'Nonce del recibo con el que /api/messages verificó esta respuesta assistant (R1). Único.';
comment on column public.messages.client_message_id is
  'Clave de idempotencia del navegador para user y advisor. Única por chat.';

commit;

-- PostgREST tiene que ver las columnas nuevas; si su caché no se recargara, el código
-- respondería 503 SCHEMA_NOT_READY hasta que lo haga.
notify pgrst, 'reload schema';

-- Verificación posterior (solo lectura): supabase/manual/20261018160000_m2_verify.sql
