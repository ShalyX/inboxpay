begin;

alter table public.policies
  add column if not exists autonomy_enabled boolean not null default false,
  add column if not exists autonomy_enabled_at timestamptz,
  add column if not exists autonomy_confirmation_version text,
  add column if not exists autonomy_last_run_at timestamptz,
  add column if not exists autonomy_last_success_at timestamptz,
  add column if not exists autonomy_last_error text;

-- Autonomy is standing payment authority, so browser clients may read it but
-- must not be able to toggle it by writing directly to PostgREST. A table-level
-- UPDATE grant would override column revokes, so replace it with an allow-list
-- for the ordinary policy fields. The policy API performs autonomy writes with
-- the server-only credential after verifying the business owner and consent.
revoke update on public.policies from authenticated;
revoke insert on public.policies from authenticated;
grant insert (
  user_id,
  business_id,
  network,
  max_transaction_usdc,
  daily_limit_usdc,
  cash_floor_usdc,
  require_verified_vendor,
  paused
) on public.policies to authenticated;
grant update (
  max_transaction_usdc,
  daily_limit_usdc,
  cash_floor_usdc,
  require_verified_vendor,
  paused,
  updated_at
) on public.policies to authenticated;

create unique index if not exists policies_one_autonomous_network_per_business
  on public.policies (business_id)
  where autonomy_enabled;

create table if not exists public.invoice_execution_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  network text not null check (network in ('ARC-TESTNET', 'ARC')),
  job_kind text not null check (job_kind in ('pay_now', 'scheduled_payment')),
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'retry', 'reconciling', 'completed', 'held', 'failed', 'cancelled')),
  scheduled_for timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  last_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (invoice_id)
);

create index if not exists invoice_execution_jobs_due_idx
  on public.invoice_execution_jobs (next_attempt_at, scheduled_for)
  where status in ('queued', 'retry', 'reconciling', 'leased');

create index if not exists invoice_execution_jobs_business_network_idx
  on public.invoice_execution_jobs (business_id, network, created_at desc);

alter table public.invoice_execution_jobs enable row level security;

drop policy if exists invoice_execution_jobs_select on public.invoice_execution_jobs;
create policy invoice_execution_jobs_select
on public.invoice_execution_jobs for select
using (
  user_id = auth.uid()
  and exists (
    select 1 from public.businesses
    where businesses.id = invoice_execution_jobs.business_id
      and businesses.owner_user_id = auth.uid()
  )
);

revoke all on public.invoice_execution_jobs from anon, authenticated;
grant select on public.invoice_execution_jobs to authenticated;

create or replace function public.claim_invoice_execution_jobs(
  worker_id text,
  batch_size integer default 5,
  lease_seconds integer default 240
)
returns setof public.invoice_execution_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  return query
  with candidates as (
    select jobs.id
    from public.invoice_execution_jobs jobs
    join public.policies policy
      on policy.business_id = jobs.business_id
     and policy.network = jobs.network
     and policy.autonomy_enabled = true
     and policy.paused = false
    where jobs.scheduled_for <= now()
      and jobs.next_attempt_at <= now()
      and (jobs.status = 'reconciling' or jobs.attempt_count < jobs.max_attempts)
      and (
        jobs.status in ('queued', 'retry', 'reconciling')
        or (jobs.status = 'leased' and jobs.lease_expires_at < now())
      )
    order by jobs.scheduled_for, jobs.created_at
    for update of jobs skip locked
    limit greatest(1, least(coalesce(batch_size, 5), 10))
  )
  update public.invoice_execution_jobs jobs
  set status = 'leased',
      lease_owner = worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(lease_seconds, 240), 600))),
      attempt_count = jobs.attempt_count + 1,
      updated_at = now()
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_invoice_execution_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_invoice_execution_jobs(text, integer, integer) to service_role;

create table if not exists public.wallet_withdrawals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null,
  network text not null check (network in ('ARC-TESTNET', 'ARC')),
  wallet_id text not null,
  wallet_address text not null,
  token_address text not null,
  recipient_address text not null,
  amount_usdc numeric(38, 6) not null check (amount_usdc > 0),
  cash_floor_usdc numeric(38, 6) not null check (cash_floor_usdc >= 0),
  reserved_usdc numeric(38, 6) not null default 0 check (reserved_usdc >= 0),
  status text not null
    check (status in ('processing', 'confirmed', 'failed', 'review')),
  circle_transaction_id text,
  transaction_hash text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (business_id, network, request_id),
  unique (circle_transaction_id)
);

create index if not exists wallet_withdrawals_business_network_idx
  on public.wallet_withdrawals (business_id, network, created_at desc);

create unique index if not exists wallet_withdrawals_one_processing_per_account
  on public.wallet_withdrawals (business_id, network)
  where status = 'processing';

alter table public.wallet_withdrawals enable row level security;

drop policy if exists wallet_withdrawals_select on public.wallet_withdrawals;
create policy wallet_withdrawals_select
on public.wallet_withdrawals for select
using (
  user_id = auth.uid()
  and exists (
    select 1 from public.businesses
    where businesses.id = wallet_withdrawals.business_id
      and businesses.owner_user_id = auth.uid()
  )
);

drop policy if exists wallet_withdrawals_insert on public.wallet_withdrawals;
drop policy if exists wallet_withdrawals_update on public.wallet_withdrawals;

revoke all on public.wallet_withdrawals from anon, authenticated;
grant select on public.wallet_withdrawals to authenticated;

create or replace function public.claim_invoice_for_payment(
  p_invoice_id uuid,
  p_business_id uuid,
  p_network text,
  p_payment_id text
)
returns setof public.invoices
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_network, 0));

  if exists (
    select 1 from public.wallet_withdrawals
    where business_id = p_business_id
      and network = p_network
      and status = 'processing'
  ) then
    raise exception 'business wallet withdrawal is processing';
  end if;

  return query
  update public.invoices as target
  set settlement_status = 'processing',
      payment_id = p_payment_id,
      updated_at = now()
  where id = p_invoice_id
    and business_id = p_business_id
    and settlement_network = p_network
    and (settlement_status is null or settlement_status = 'failed')
  returning target.*;
end;
$$;

revoke all on function public.claim_invoice_for_payment(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_for_payment(uuid, uuid, text, text) to service_role;

create or replace function public.prepare_wallet_withdrawal(
  p_request_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_network text,
  p_wallet_id text,
  p_wallet_address text,
  p_token_address text,
  p_recipient_address text,
  p_amount_usdc numeric
)
returns setof public.wallet_withdrawals
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || p_network, 0));

  if exists (
    select 1 from public.invoices
    where business_id = p_business_id
      and settlement_network = p_network
      and settlement_status = 'processing'
  ) then
    raise exception 'invoice payment is processing';
  end if;

  return query
  insert into public.wallet_withdrawals as target (
    request_id,
    business_id,
    user_id,
    network,
    wallet_id,
    wallet_address,
    token_address,
    recipient_address,
    amount_usdc,
    cash_floor_usdc,
    reserved_usdc,
    status
  ) values (
    p_request_id,
    p_business_id,
    p_user_id,
    p_network,
    p_wallet_id,
    p_wallet_address,
    p_token_address,
    p_recipient_address,
    p_amount_usdc,
    0,
    0,
    'processing'
  )
  on conflict (business_id, network, request_id) do update
    set request_id = excluded.request_id
  returning target.*;
end;
$$;

revoke all on function public.prepare_wallet_withdrawal(uuid, uuid, uuid, text, text, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.prepare_wallet_withdrawal(uuid, uuid, uuid, text, text, text, text, text, numeric) to service_role;

commit;
