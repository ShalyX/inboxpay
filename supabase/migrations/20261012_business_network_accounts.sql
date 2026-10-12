begin;

alter table public.businesses
  add column if not exists active_network text;

update public.businesses
set active_network = case
  when wallet_blockchain in ('ARC-TESTNET', 'ARC') then wallet_blockchain
  else 'ARC-TESTNET'
end
where active_network is null;

alter table public.businesses
  alter column active_network set default 'ARC-TESTNET',
  alter column active_network set not null;

alter table public.businesses
  drop constraint if exists businesses_active_network_check;

alter table public.businesses
  add constraint businesses_active_network_check
  check (active_network in ('ARC-TESTNET', 'ARC'));

create table if not exists public.business_network_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  network text not null check (network in ('ARC-TESTNET', 'ARC')),
  wallet_set_id text,
  wallet_id text,
  wallet_address text,
  wallet_blockchain text not null check (wallet_blockchain in ('ARC-TESTNET', 'ARC')),
  wallet_status text not null default 'not_provisioned',
  wallet_error text,
  policy_contract_id text,
  policy_contract_address text,
  policy_contract_status text not null default 'not_deployed',
  policy_contract_tx_id text,
  policy_contract_blockchain text not null check (policy_contract_blockchain in ('ARC-TESTNET', 'ARC')),
  policy_contract_error text,
  policy_contract_configured_at timestamptz,
  policy_contract_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, network),
  unique (wallet_set_id),
  unique (wallet_id),
  unique (wallet_address),
  unique (policy_contract_id),
  unique (policy_contract_address),
  unique (policy_contract_tx_id)
);

insert into public.business_network_accounts (
  business_id,
  network,
  wallet_set_id,
  wallet_id,
  wallet_address,
  wallet_blockchain,
  wallet_status,
  wallet_error,
  policy_contract_id,
  policy_contract_address,
  policy_contract_status,
  policy_contract_tx_id,
  policy_contract_blockchain,
  policy_contract_error,
  policy_contract_configured_at,
  policy_contract_sync_error,
  created_at,
  updated_at
)
select
  id,
  active_network,
  wallet_set_id,
  wallet_id,
  wallet_address,
  active_network,
  coalesce(wallet_status, case when wallet_id is null then 'not_provisioned' else 'ready' end),
  wallet_error,
  policy_contract_id,
  policy_contract_address,
  coalesce(policy_contract_status, case when policy_contract_address is null then 'not_deployed' else 'ready' end),
  policy_contract_tx_id,
  active_network,
  policy_contract_error,
  policy_contract_configured_at,
  policy_contract_sync_error,
  coalesce(created_at, now()),
  coalesce(updated_at, now())
from public.businesses
where wallet_id is not null
   or wallet_address is not null
   or policy_contract_id is not null
   or policy_contract_address is not null
on conflict (business_id, network) do nothing;

alter table public.business_network_accounts enable row level security;

drop policy if exists business_network_accounts_select on public.business_network_accounts;
create policy business_network_accounts_select
on public.business_network_accounts for select
using (
  exists (
    select 1 from public.businesses
    where businesses.id = business_network_accounts.business_id
      and businesses.owner_user_id = auth.uid()
  )
);

drop policy if exists business_network_accounts_insert on public.business_network_accounts;
create policy business_network_accounts_insert
on public.business_network_accounts for insert
with check (
  exists (
    select 1 from public.businesses
    where businesses.id = business_network_accounts.business_id
      and businesses.owner_user_id = auth.uid()
  )
);

drop policy if exists business_network_accounts_update on public.business_network_accounts;
create policy business_network_accounts_update
on public.business_network_accounts for update
using (
  exists (
    select 1 from public.businesses
    where businesses.id = business_network_accounts.business_id
      and businesses.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.businesses
    where businesses.id = business_network_accounts.business_id
      and businesses.owner_user_id = auth.uid()
  )
);

revoke all on public.business_network_accounts from anon;
grant select, insert, update on public.business_network_accounts to authenticated;

alter table public.policies add column if not exists network text;
alter table public.vendors add column if not exists network text;
alter table public.invoices add column if not exists settlement_network text;
alter table public.audit_events add column if not exists network text;

update public.policies p
set network = b.active_network
from public.businesses b
where p.business_id = b.id and p.network is null;

update public.vendors v
set network = b.active_network
from public.businesses b
where v.business_id = b.id and v.network is null;

update public.invoices i
set settlement_network = b.active_network
from public.businesses b
where i.business_id = b.id and i.settlement_network is null;

update public.audit_events a
set network = b.active_network
from public.businesses b
where a.business_id = b.id and a.network is null;

update public.policies set network = 'ARC-TESTNET' where network is null;
update public.vendors set network = 'ARC-TESTNET' where network is null;
update public.invoices set settlement_network = 'ARC-TESTNET' where settlement_network is null;
update public.audit_events set network = 'ARC-TESTNET' where network is null;

alter table public.policies alter column network set not null;
alter table public.vendors alter column network set not null;
alter table public.invoices alter column settlement_network set not null;
alter table public.audit_events alter column network set not null;

alter table public.policies drop constraint if exists policies_network_check;
alter table public.policies add constraint policies_network_check check (network in ('ARC-TESTNET', 'ARC'));
alter table public.vendors drop constraint if exists vendors_network_check;
alter table public.vendors add constraint vendors_network_check check (network in ('ARC-TESTNET', 'ARC'));
alter table public.invoices drop constraint if exists invoices_settlement_network_check;
alter table public.invoices add constraint invoices_settlement_network_check check (settlement_network in ('ARC-TESTNET', 'ARC'));
alter table public.audit_events drop constraint if exists audit_events_network_check;
alter table public.audit_events add constraint audit_events_network_check check (network in ('ARC-TESTNET', 'ARC'));

alter table public.policies drop constraint if exists policies_user_id_key;
alter table public.vendors drop constraint if exists vendors_business_id_name_key;
alter table public.invoices drop constraint if exists invoices_user_id_external_message_id_invoice_number_key;

create unique index if not exists policies_business_network_key
  on public.policies (business_id, network);

create unique index if not exists vendors_business_network_name_key
  on public.vendors (business_id, network, name);

create unique index if not exists invoices_user_message_number_network_key
  on public.invoices (user_id, external_message_id, invoice_number, settlement_network);

create index if not exists invoices_business_network_idx
  on public.invoices (business_id, settlement_network, created_at desc);

create index if not exists audit_events_business_network_idx
  on public.audit_events (business_id, network, created_at desc);

create or replace function public.inboxpay_assign_business_network()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table_name = 'invoices' then
    if new.settlement_network is null then
      select active_network into new.settlement_network
      from public.businesses where id = new.business_id;
    end if;
  elsif new.network is null then
    select active_network into new.network
    from public.businesses where id = new.business_id;
  end if;
  return new;
end;
$$;

drop trigger if exists policies_assign_business_network on public.policies;
create trigger policies_assign_business_network
before insert on public.policies
for each row execute function public.inboxpay_assign_business_network();

drop trigger if exists vendors_assign_business_network on public.vendors;
create trigger vendors_assign_business_network
before insert on public.vendors
for each row execute function public.inboxpay_assign_business_network();

drop trigger if exists invoices_assign_business_network on public.invoices;
create trigger invoices_assign_business_network
before insert on public.invoices
for each row execute function public.inboxpay_assign_business_network();

drop trigger if exists audit_events_assign_business_network on public.audit_events;
create trigger audit_events_assign_business_network
before insert on public.audit_events
for each row execute function public.inboxpay_assign_business_network();

commit;
