\set ON_ERROR_STOP on
begin isolation level repeatable read;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if current_setting('inboxpay.retention_mode',true) is distinct from 'approved_apply' then
    raise exception 'Explicit retention apply approval is required';
  end if;
end $$;
select pg_advisory_xact_lock(hashtext('inboxpay-data-retention'));
set local role service_role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claims = '{"role":"service_role"}';

drop table if exists pg_temp.inboxpay_retention_links;
drop table if exists pg_temp.inboxpay_retention_jobs;
drop table if exists pg_temp.inboxpay_retention_receipt;
create temporary table inboxpay_retention_links as
  select id from public.business_notification_link_tokens
  where expires_at < statement_timestamp()-interval '1 day'
  order by expires_at,id limit 500;
create temporary table inboxpay_retention_jobs as
  select id,source_key,status from public.business_payment_notification_jobs
  where status in ('delivered','failed','skipped') and updated_at < statement_timestamp()-interval '30 days'
    and payload_redacted_at is null
  order by updated_at,id limit 500;
create temporary table inboxpay_retention_receipt(result jsonb);
do $$
declare applied jsonb; remaining jsonb; expected_links integer; expected_jobs integer;
begin
  perform 1 from public.business_notification_link_tokens t join pg_temp.inboxpay_retention_links c on t.id=c.id
    order by t.id for update of t;
  perform 1 from public.business_payment_notification_jobs j join pg_temp.inboxpay_retention_jobs c on j.id=c.id
    order by j.id for update of j;
  select count(*) into expected_links from pg_temp.inboxpay_retention_links;
  select count(*) into expected_jobs from pg_temp.inboxpay_retention_jobs;
  applied := public.run_business_data_retention(false,500);
  if (applied->>'expiredLinks')::integer <> expected_links
    or (applied->>'terminalPayloads')::integer <> expected_jobs then
    raise exception 'Retention candidates changed; transaction rolled back, inspect before retrying';
  end if;
  if exists(select 1 from public.business_notification_link_tokens t join pg_temp.inboxpay_retention_links c on t.id=c.id)
    or (select count(*) from public.business_payment_notification_jobs j join pg_temp.inboxpay_retention_jobs c on j.id=c.id
      where j.source_key=c.source_key and j.status=c.status and j.payload='{}'::jsonb
        and j.payload_redacted_at is not null and j.last_error is null and j.telegram_message_id is null
        and j.lease_token is null and j.lease_expires_at is null) <> expected_jobs then
    raise exception 'Retention readback failed; transaction rolled back';
  end if;
  remaining := public.run_business_data_retention(true,500);
  insert into pg_temp.inboxpay_retention_receipt values(jsonb_build_object(
    'verified',true,'applied',applied,'remaining',remaining));
end $$;
commit;
-- Emit a receipt only after the verified batch has committed. No row IDs/content.
select result as committed_retention_receipt from pg_temp.inboxpay_retention_receipt;
drop table pg_temp.inboxpay_retention_links,pg_temp.inboxpay_retention_jobs,pg_temp.inboxpay_retention_receipt;
