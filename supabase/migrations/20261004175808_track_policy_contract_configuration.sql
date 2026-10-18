alter table public.businesses
  add column if not exists policy_contract_configured_at timestamptz,
  add column if not exists policy_contract_sync_error text;
