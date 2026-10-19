create table if not exists public.business_notification_channels (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel = 'telegram'),
  destination_encrypted text not null,
  destination_hint text not null,
  chat_type text not null default 'private',
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  preferences jsonb not null default '{"service_attention":true,"service_recovered":true}'::jsonb,
  linked_at timestamptz not null default now(),
  last_tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, channel)
);

create table if not exists public.business_notification_link_tokens (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel = 'telegram'),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists business_notification_channels_business_idx
  on public.business_notification_channels (business_id, status);
create index if not exists business_notification_link_tokens_lookup_idx
  on public.business_notification_link_tokens (token_hash, expires_at)
  where consumed_at is null;

alter table public.business_notification_channels enable row level security;
alter table public.business_notification_link_tokens enable row level security;

revoke all on public.business_notification_channels from anon, authenticated;
revoke all on public.business_notification_link_tokens from anon, authenticated;

comment on table public.business_notification_channels is
  'Server-only encrypted per-business notification destinations. Platform operator alerts remain separate.';
comment on table public.business_notification_link_tokens is
  'Short-lived, one-time hashes used to link a Telegram chat to exactly one InboxPay business.';

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
  on conflict (business_id, channel) do update set
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
