-- Verificación de M2 (20261018184547_message_provenance_receipt_idempotency). SOLO LECTURA.
-- Fuera de supabase/migrations a propósito: no lo aplica db push.
-- Cada fila trae ok = true si la comprobación pasa. Antes de aplicar M2, guardar el resultado
-- de la consulta 2 para compararlo con el posterior.

-- 1) Esquema: CHECK de role, columnas, checks e índices nuevos.
select 'role_check' as item,
       pg_get_constraintdef(oid) = 'CHECK ((role = ANY (ARRAY[''user''::text, ''assistant''::text, ''advisor''::text])))' as ok,
       pg_get_constraintdef(oid) as detail
from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_role_check'
union all
select 'col_' || column_name, data_type = case column_name when 'receipt_nonce' then 'text' else 'uuid' end and is_nullable = 'YES',
       data_type || ' nullable=' || is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'messages' and column_name in ('receipt_nonce', 'client_message_id')
union all
select conname, convalidated, pg_get_constraintdef(oid)
from pg_constraint where conrelid = 'public.messages'::regclass
  and conname in ('messages_receipt_nonce_format', 'messages_receipt_nonce_assistant_only')
union all
select indexname, indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%WHERE%IS NOT NULL%', indexdef
from pg_indexes where schemaname = 'public' and tablename = 'messages'
  and indexname in ('messages_receipt_nonce_key', 'messages_chat_client_message_id_key');
-- Esperado: 7 filas, todas ok = true.

-- 2) Datos: conteo por role y columnas nuevas (debe coincidir con el previo; nuevas en NULL).
select role, count(*) as total,
       count(receipt_nonce) as with_receipt_nonce,
       count(client_message_id) as with_client_message_id
from public.messages group by role order by role;
-- Esperado justo después de aplicar: los mismos totales por role que antes, sin advisor ni
-- system, y 0 en las dos columnas nuevas.

-- 3) Vistas que dependen de messages siguen respondiendo.
select (select count(*) from public.v_student_usage) >= 0 as v_student_usage_ok,
       (select count(*) from public.v_bi_usage_daily) >= 0 as v_bi_usage_daily_ok;

-- 4) Permisos: authenticated sigue sin escribir (M1).
select p.priv, has_table_privilege('authenticated', 'public.messages', p.priv) as granted
from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv);
-- Esperado: granted = false en las cuatro.
