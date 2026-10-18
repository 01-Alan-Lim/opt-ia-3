-- Reversión completa de M2 (20261018184547_message_provenance_receipt_idempotency).
-- Fuera de supabase/migrations a propósito: no lo aplica db push. Ejecutar solo a mano y solo
-- después de haber revertido el código del release (el código nuevo necesita M2).
--
-- Lo preferible es NO correr esto: M2 es compatible con el código anterior, así que basta con
-- revertir el código. Este script se niega a continuar si ya hay filas advisor, porque
-- devolverlas a assistant las atribuiría a la IA; esa decisión no se toma aquí.
--
-- Se pierden receipt_nonce y client_message_id: la protección contra recibos repetidos y la
-- idempotencia de reintentos.

begin;

do $$
begin
  if exists (select 1 from public.messages where role = 'advisor') then
    raise exception 'Hay mensajes advisor: revertir M2 obligaría a reclasificarlos. Revertir solo el código.';
  end if;
end
$$;

drop index if exists public.messages_chat_client_message_id_key;
drop index if exists public.messages_receipt_nonce_key;

alter table public.messages drop constraint if exists messages_receipt_nonce_assistant_only;
alter table public.messages drop constraint if exists messages_receipt_nonce_format;

alter table public.messages drop column if exists client_message_id;
alter table public.messages drop column if exists receipt_nonce;

alter table public.messages drop constraint if exists messages_role_check;
alter table public.messages
  add constraint messages_role_check check (role in ('user', 'assistant', 'system'));

commit;

notify pgrst, 'reload schema';
