create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google_gmail')),
  provider_account_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'reauth_required', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  integration_id uuid references public.integrations(id) on delete set null,
  external_message_id text,
  external_thread_id text,
  vendor text,
  invoice_number text,
  amount numeric(20,6),
  currency text,
  due_date date,
  decision text,
  decision_reasons jsonb not null default '[]',
  extraction jsonb not null default '{}',
  sources jsonb not null default '[]',
  payment_id text,
  settlement_status text,
  payment_tx_hash text,
  raw_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_message_id, invoice_number)
);

create table public.policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  max_transaction_usdc numeric(20,6) not null default 1000,
  daily_limit_usdc numeric(20,6) not null default 5000,
  cash_floor_usdc numeric(20,6) not null default 20,
  require_verified_vendor boolean not null default true,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  event_type text not null,
  actor text not null default 'system',
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.integrations enable row level security;
alter table public.invoices enable row level security;
alter table public.policies enable row level security;
alter table public.audit_events enable row level security;

create policy "users own integrations" on public.integrations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users own invoices" on public.invoices
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users own policies" on public.policies
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users own audit events" on public.audit_events
  for select to authenticated
  using ((select auth.uid()) = user_id);
