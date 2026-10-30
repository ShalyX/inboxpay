begin;
do $$ begin
  if current_setting('inboxpay.restore_mode', true) is distinct from 'isolated' then
    raise exception 'Notification cleanup requires an isolated restore';
  end if;
end $$;
-- Never restore old chat credentials, one-time links or deliverable snapshots.
-- Preserve source keys to prevent replay. Does not touch invoice/payment rows.
delete from public.business_notification_link_tokens;
update public.business_notification_channels set status = 'revoked', destination_encrypted = '',
  destination_hint = '', preferences = '{}'::jsonb, updated_at = now();
update public.business_payment_notification_jobs set payload = '{}'::jsonb, status = 'skipped',
  last_error = null, telegram_message_id = null, lease_token = null, lease_expires_at = null;
do $$ begin
  if exists (select 1 from public.business_notification_channels where status <> 'revoked'
      or destination_encrypted <> '' or destination_hint <> '')
    or exists (select 1 from public.business_notification_link_tokens)
    or exists (select 1 from public.business_payment_notification_jobs where payload <> '{}'::jsonb
      or status <> 'skipped' or lease_token is not null or telegram_message_id is not null or last_error is not null) then
    raise exception 'Restored notification cleanup verification failed';
  end if;
end $$;
commit;
