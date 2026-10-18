create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'My Business',
  slug text not null unique,
  wallet_set_id text unique,
  wallet_id text unique,
  wallet_address text unique,
  wallet_blockchain text,
  wallet_status text not null default 'not_provisioned'
    check (wallet_status in ('not_provisioned', 'provisioning', 'ready', 'error')),
  wallet_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  recipient_address text not null,
  currency text not null default 'USDC',
  status text not null default 'verified' check (status in ('verified', 'review', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, name)
);

alter table public.integrations
  add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.invoices
  add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.policies
  add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.audit_events
  add column if not exists business_id uuid references public.businesses(id) on delete cascade;

alter table public.businesses enable row level security;
alter table public.vendors enable row level security;

create policy "users own business" on public.businesses
  for all to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);

create policy "business owners own vendors" on public.vendors
  for all to authenticated
  using (
    exists (
      select 1
      from public.businesses b
      where b.id = business_id
        and b.owner_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.businesses b
      where b.id = business_id
        and b.owner_user_id = (select auth.uid())
    )
  );

create index if not exists invoices_business_id_idx on public.invoices(business_id);
create index if not exists integrations_business_id_idx on public.integrations(business_id);
create index if not exists audit_events_business_id_idx on public.audit_events(business_id);
create unique index if not exists integrations_google_account_unique
  on public.integrations(provider, provider_account_id)
  where provider_account_id is not null;
