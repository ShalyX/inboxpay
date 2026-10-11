-- Remote operator handoff for scoped InboxPay rehearsals.
-- Apply this migration in Supabase before enabling /api/operator/*.
-- The service role is the only role allowed to read or write handoff rows.

create table if not exists public.operator_handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  token_hash text not null unique,
  session_token_encrypted text not null,
  scope text not null check (scope = 'rehearsal_read_refresh'),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists operator_handoffs_active_lookup
  on public.operator_handoffs (token_hash, expires_at)
  where revoked_at is null;

alter table public.operator_handoffs enable row level security;

revoke all on public.operator_handoffs from anon, authenticated;
grant all on public.operator_handoffs to service_role;

-- Keep expired/revoked bearer records from accumulating.
-- Run this from a scheduled Supabase job or periodically from an operator maintenance task.
delete from public.operator_handoffs
where expires_at < now() or revoked_at < now() - interval '1 day';
