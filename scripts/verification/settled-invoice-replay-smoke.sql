\set ON_ERROR_STOP on

-- Production-only verification of one exact settled Arc Testnet invoice.
-- The claim RPC is called inside a transaction that is ALWAYS rolled back.
-- If a regression makes it claim the invoice, no changed row can commit.
begin;

select id as invoice_id, business_id, settlement_network as network, payment_id
from public.invoices
where invoice_number = :'invoice_number'
  and settlement_network = 'ARC-TESTNET'
  and settlement_status = 'confirmed'
  and payment_tx_hash = :'tx_hash'
\gset

select 1 / (case when
  :'payment_id' = :'expected_payment_id'
  and not exists (
    select 1 from public.wallet_withdrawals
    where business_id = :'business_id'::uuid
      and network = :'network'
      and status = 'processing'
  )
then 1 else 0 end) as exact_settled_invoice_precondition;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true) as claim_role \gset

select count(*) as replay_claims
from public.claim_invoice_for_payment(
  :'invoice_id'::uuid,
  :'business_id'::uuid,
  :'network',
  :'payment_id'
)
\gset

select 1 / (case when :replay_claims::int = 0 then 1 else 0 end)
  as settled_invoice_replay_rejected;

rollback;

select 1 / (case when count(*) = 1 then 1 else 0 end) as original_settlement_unchanged
from public.invoices
where id = :'invoice_id'::uuid
  and settlement_status = 'confirmed'
  and payment_tx_hash = :'tx_hash';
