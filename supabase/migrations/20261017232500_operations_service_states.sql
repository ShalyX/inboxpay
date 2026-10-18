create table if not exists public.operations_service_states (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  network text not null check (network in ('ARC', 'ARC-TESTNET')),
  service text not null check (service in ('gmail', 'circle', 'arc', 'supabase', 'reconciliation')),
  status text not null check (status in ('healthy', 'recovering', 'attention', 'degraded')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  detail text not null,
  action text not null,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  first_failed_at timestamptz,
  last_failed_at timestamptz,
  last_checked_at timestamptz not null default now(),
  last_transition_at timestamptz not null default now(),
  last_notified_at timestamptz,
  notification_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, network, service)
);

create index if not exists operations_service_states_attention_idx
  on public.operations_service_states (status, last_checked_at desc)
  where status in ('attention', 'degraded');

alter table public.operations_service_states enable row level security;

create policy "business owners view operations service states"
  on public.operations_service_states
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.businesses b
      where b.id = business_id
        and b.owner_user_id = (select auth.uid())
    )
  );

revoke insert, update, delete on public.operations_service_states from authenticated;
grant select on public.operations_service_states to authenticated;
