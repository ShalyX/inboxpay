alter table public.businesses
  add column if not exists policy_contract_id text unique,
  add column if not exists policy_contract_address text unique,
  add column if not exists policy_contract_status text not null default 'not_deployed'
    check (policy_contract_status in ('not_deployed', 'deploying', 'ready', 'error')),
  add column if not exists policy_contract_tx_id text,
  add column if not exists policy_contract_blockchain text,
  add column if not exists policy_contract_error text;

create index if not exists businesses_policy_contract_status_idx
  on public.businesses(policy_contract_status);
