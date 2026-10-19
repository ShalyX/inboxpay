-- The OUT parameter business_id in the original function collides with the
-- unqualified ON CONFLICT target when PostgreSQL resolves PL/pgSQL names.
-- Use the named unique constraint so Telegram retries can finish linking.
create or replace function public.consume_business_telegram_link(
  p_token_hash text,
  p_destination_encrypted text,
  p_destination_hint text,
  p_chat_type text
)
returns table (business_id uuid, user_id uuid, network text)
language plpgsql security definer set search_path = '' as $$
declare
  linked_token public.business_notification_link_tokens%rowtype;
  selected_network text;
begin
  update public.business_notification_link_tokens
  set consumed_at = now()
  where token_hash = p_token_hash and consumed_at is null and expires_at > now()
  returning * into linked_token;
  if not found then return; end if;

  select coalesce(b.active_network, 'ARC-TESTNET') into selected_network
  from public.businesses b
  where b.id = linked_token.business_id and b.owner_user_id = linked_token.user_id;
  if selected_network is null then
    raise exception 'Telegram link business ownership changed';
  end if;

  insert into public.business_notification_channels (
    business_id, user_id, channel, destination_encrypted, destination_hint, chat_type, status, linked_at, updated_at
  ) values (
    linked_token.business_id, linked_token.user_id, 'telegram', p_destination_encrypted,
    p_destination_hint, p_chat_type, 'active', now(), now()
  )
  on conflict on constraint business_notification_channels_business_id_channel_key do update set
    user_id = excluded.user_id,
    destination_encrypted = excluded.destination_encrypted,
    destination_hint = excluded.destination_hint,
    chat_type = excluded.chat_type,
    status = 'active',
    linked_at = now(),
    updated_at = now();

  insert into public.audit_events (business_id, user_id, network, event_type, actor, data)
  values (
    linked_token.business_id, linked_token.user_id, selected_network,
    'telegram_notifications_connected', 'telegram', jsonb_build_object('chat_type', p_chat_type)
  );

  return query select linked_token.business_id, linked_token.user_id, selected_network;
end;
$$;

revoke all on function public.consume_business_telegram_link(text, text, text, text) from public, anon, authenticated;
grant execute on function public.consume_business_telegram_link(text, text, text, text) to service_role;
