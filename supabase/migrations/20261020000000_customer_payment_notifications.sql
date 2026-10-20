-- Customer payment messages are queued only for an already-linked business chat.
-- The queue is server-only and contains a snapshot, so a later invoice edit cannot
-- turn a submitted/failed event into a false confirmed message.
create table public.business_payment_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  network text not null check (network in ('ARC', 'ARC-TESTNET')),
  channel_id uuid not null references public.business_notification_channels(id) on delete cascade,
  channel_linked_at timestamptz not null,
  event_type text not null check (event_type in ('payment_submitted', 'payment_confirmed', 'payment_failed', 'payment_review')),
  source_key text not null unique,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'leased', 'delivered', 'failed', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);

create index business_payment_notification_due_idx
  on public.business_payment_notification_jobs (next_attempt_at, created_at)
  where status in ('queued', 'leased');
create index business_payment_notification_business_idx
  on public.business_payment_notification_jobs (business_id, created_at desc);

alter table public.business_payment_notification_jobs enable row level security;
revoke all on public.business_payment_notification_jobs from anon, authenticated;

create function public.queue_business_payment_notification(
  p_invoice public.invoices, p_event_type text, p_source_key text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  linked_channel public.business_notification_channels%rowtype;
begin
  if p_invoice.business_id is null or p_invoice.settlement_network not in ('ARC', 'ARC-TESTNET') then
    return;
  end if;
  select c.* into linked_channel
  from public.business_notification_channels c
  join public.businesses b on b.id = c.business_id and b.owner_user_id = c.user_id
  where c.business_id = p_invoice.business_id and c.channel = 'telegram' and c.status = 'active'
    and c.user_id = p_invoice.user_id;
  if not found then return; end if;

  insert into public.business_payment_notification_jobs (
    business_id, user_id, invoice_id, network, channel_id, channel_linked_at,
    event_type, source_key, payload
  ) values (
    p_invoice.business_id, p_invoice.user_id, p_invoice.id, p_invoice.settlement_network,
    linked_channel.id, linked_channel.linked_at, p_event_type, p_source_key,
    jsonb_build_object(
      'invoice_number', p_invoice.invoice_number,
      'vendor', p_invoice.vendor,
      'amount_usdc', p_invoice.amount,
      'tx_hash', p_invoice.payment_tx_hash
    )
  ) on conflict (source_key) do nothing;
end;
$$;

create function public.queue_business_payment_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  invoice_record public.invoices%rowtype;
  customer_event text;
begin
  -- Authenticated owners can write some audit rows; only the payment server may
  -- assert a provider submission or reconciled settlement to a customer.
  if auth.role() <> 'service_role' or new.invoice_id is null then return new; end if;
  customer_event := case new.event_type
    when 'payment_submitted' then 'payment_submitted'
    when 'payment_settled' then 'payment_confirmed'
    when 'payment_failed' then 'payment_failed'
    when 'payment_reconciliation_review' then 'payment_review'
    else null
  end;
  if customer_event is null then return new; end if;
  select * into invoice_record from public.invoices where id = new.invoice_id
    and business_id = new.business_id and user_id = new.user_id and settlement_network = new.network;
  if not found then return new; end if;
  if (customer_event = 'payment_submitted' and (
      invoice_record.settlement_status is distinct from 'processing'
      or nullif(new.data->>'circle_transaction_id', '') is null
    ))
    or (customer_event = 'payment_confirmed' and (
      invoice_record.settlement_status is distinct from 'confirmed' or invoice_record.payment_tx_hash is null
      or lower(invoice_record.payment_tx_hash) <> lower(coalesce(new.data->>'tx_hash', ''))
    ))
    or (customer_event = 'payment_failed' and invoice_record.settlement_status is distinct from 'failed')
    or (customer_event = 'payment_review' and invoice_record.settlement_status is distinct from 'review') then
    return new;
  end if;
  perform public.queue_business_payment_notification(
    invoice_record, customer_event,
    case customer_event
      when 'payment_submitted' then 'submission:' || invoice_record.id::text || ':' || (new.data->>'circle_transaction_id')
      when 'payment_confirmed' then 'confirmed:' || invoice_record.id::text || ':' || lower(invoice_record.payment_tx_hash)
      else 'audit:' || new.id::text
    end
  );
  return new;
end;
$$;

create trigger queue_business_payment_audit
after insert on public.audit_events
for each row execute function public.queue_business_payment_audit();

create function public.claim_business_payment_notifications(p_batch_size integer default 3)
returns setof public.business_payment_notification_jobs
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  return query
  with due as (
    select id from public.business_payment_notification_jobs
    where ((status = 'queued' and next_attempt_at <= now())
      or (status = 'leased' and lease_expires_at <= now()))
      and attempt_count < 5
    order by created_at, id
    for update skip locked
    limit least(greatest(coalesce(p_batch_size, 3), 1), 5)
  )
  update public.business_payment_notification_jobs j
  set status = 'leased', attempt_count = j.attempt_count + 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '45 seconds', updated_at = now()
  from due where j.id = due.id
  returning j.*;
end;
$$;

create function public.finish_business_payment_notification(
  p_job_id uuid, p_lease_token uuid, p_outcome text,
  p_telegram_message_id bigint default null, p_error text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  if p_outcome not in ('delivered', 'retry', 'skipped') then raise exception 'invalid delivery outcome'; end if;
  update public.business_payment_notification_jobs j
  set status = case
        when p_outcome = 'retry' and j.attempt_count < 5 then 'queued'
        when p_outcome = 'retry' then 'failed'
        else p_outcome end,
      next_attempt_at = case when p_outcome = 'retry'
        then now() + (power(2, least(j.attempt_count, 5))::integer * interval '1 minute')
        else j.next_attempt_at end,
      telegram_message_id = case when p_outcome = 'delivered' then p_telegram_message_id else j.telegram_message_id end,
      delivered_at = case when p_outcome = 'delivered' then now() else j.delivered_at end,
      last_error = left(p_error, 160), lease_token = null, lease_expires_at = null, updated_at = now()
  where j.id = p_job_id and j.lease_token = p_lease_token and j.status = 'leased'
  returning j.id into changed_id;
  return changed_id is not null;
end;
$$;

revoke all on function public.queue_business_payment_notification(public.invoices, text, text) from public, anon, authenticated;
revoke all on function public.queue_business_payment_audit() from public, anon, authenticated;
revoke all on function public.claim_business_payment_notifications(integer) from public, anon, authenticated;
revoke all on function public.finish_business_payment_notification(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.claim_business_payment_notifications(integer) to service_role;
grant execute on function public.finish_business_payment_notification(uuid, uuid, text, bigint, text) to service_role;
