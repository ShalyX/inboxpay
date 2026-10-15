# InboxPay autonomy and business-funds runbook

This runbook applies to the bounded autonomous-payment worker and business-wallet withdrawals introduced on `codex/autonomy-wallet-control`. It does not authorize a Mainnet payment, withdrawal, allowance, vendor registration, or contract migration by itself.

## Safety model

- Autonomy is disabled by default and enabled per business and Arc network only after explicit owner confirmation.
- Only one network can have standing autonomous authority for a business at a time.
- Each due payment rechecks the live invoice decision, business/network ownership, verified vendor, onchain policy, allowance, duplicate marker, per-payment and daily limits, cash floor, and pause state.
- The worker reuses the existing payment idempotency and reconciliation path. A delayed Circle or Arc result remains reconciling and is not submitted again as a new payment.
- Withdrawals originate only from the business's dedicated Circle wallet. They preserve the cash floor, reserve funds for active autonomous jobs, require an exact user confirmation, and remain pending until Circle plus the Arc receipt agree.
- `BusinessPolicyVault` is allowance-based and does not custody a separate balance. Its `vaultBalance()` reports the owner wallet balance, so there is no policy-vault-to-wallet withdrawal to expose.

## Required database change

Apply `supabase/migrations/20261015_autonomy_and_withdrawals.sql` in the production Supabase project before deploying the application code.

The migration adds durable execution jobs, withdrawal records, leases, retry/reconciliation state, RLS, a service-role-only claim function, and server-only autonomy-control columns. Confirm the migration committed successfully before continuing.

## Required Vercel secrets

Add these as encrypted Production environment variables and redeploy:

- `SUPABASE_SECRET_KEY`: a dedicated `sb_secret_...` backend key for InboxPay. A legacy `SUPABASE_SERVICE_ROLE_KEY` remains supported during migration, but the dedicated secret key is preferred.
- `AUTONOMY_CRON_SECRET`: a randomly generated, dedicated value of at least 32 bytes. It protects only the worker endpoint and must not be reused as a Supabase, Circle, Gmail, or encryption key.

Keep the existing per-environment Circle credentials, Gmail OAuth credentials, token-encryption key, Supabase publishable key, and Arc RPC configuration. Do not add a shared wallet ID or treasury address; wallet identity continues to come from each business's isolated network account.

Do not enable `INBOXPAY_ALLOW_MAINNET_WRITES=true` merely to test the worker. Test the full lifecycle on Arc Testnet first. Mainnet writes require a separate release decision and explicit business authorization.

## Scheduler

Vercel Hobby cron timing is not suitable for invoice due-time execution. Use Supabase Cron (`pg_cron`) plus `pg_net` to invoke the existing `/api/invoices` function every minute without adding a thirteenth Vercel function.

Store the endpoint and the limited-purpose worker secret in Supabase Vault. Replace only the placeholder secret values below:

```sql
select vault.create_secret(
  'https://tameion-ap-agent-live.vercel.app/api/invoices',
  'inboxpay_autonomy_url'
);

select vault.create_secret(
  '<same random value as AUTONOMY_CRON_SECRET>',
  'inboxpay_autonomy_cron_secret'
);
```

After the migration, application deployment, and Testnet readiness check are complete, create the job:

```sql
select cron.schedule(
  'inboxpay-autonomy',
  '* * * * *',
  $job$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'inboxpay_autonomy_url'
      limit 1
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'inboxpay_autonomy_cron_secret'
        limit 1
      )
    ),
    body := jsonb_build_object('action', 'autonomy_tick'),
    timeout_milliseconds := 250000
  ) as request_id;
  $job$
);
```

The worker secret is intentionally not a Supabase secret key. `pg_net` temporarily queues request headers, so use a unique, limited-purpose value and rotate it if database access changes.

## Testnet activation proof

1. Keep the business on Arc Testnet and confirm its dedicated wallet, connected Gmail integration, ready `BusinessPolicyVault`, non-paused policy, verified test vendor, and nonzero policy allowance.
2. Confirm `AUTONOMY_CRON_SECRET` rejects a missing or incorrect bearer value and accepts the configured value.
3. Enable bounded autonomy in the Payment policy page. Record the resulting `payment_autonomy_enabled` event.
4. Deliver one controlled invoice from the verified test vendor. Use an amount inside every configured limit and above no cash-floor boundary.
5. Verify the worker records `invoice_evaluated`, creates exactly one `invoice_execution_jobs` row, and records `invoice_autonomy_queued`.
6. For a future invoice, verify the job remains queued until its stored `scheduled_for`; it must not be pulled forward when the evaluator changes from `SCHEDULE` to `PAY_NOW` earlier on the due date.
7. Verify one `invoice_autonomy_attempted` event, one Circle submission ID, one Arc transaction hash, `usedPayment=true`, the matching vendor balance increase/event, and final invoice/job status `confirmed`/`completed`.
8. Repeat the worker request concurrently and after completion. Confirm there is no second Circle submission or payment.
9. Run rejection cases for an unverified vendor, paused policy, amount limit, daily limit, cash floor, revoked allowance, wrong network, and cross-business invoice. Every case must hold or fail without a Circle submission.
10. Exercise one small Testnet wallet withdrawal to a controlled address. Confirm the stored request, Circle transaction, matching Arc receipt, final status, and unchanged policy-vault custody wording.

Mocked/unit tests and a successful build are necessary but do not replace this Testnet proof.

## Monitoring and recovery

Inspect scheduler runs:

```sql
select jobid, status, return_message, start_time, end_time
from cron.job_run_details
where jobname = 'inboxpay-autonomy'
order by start_time desc
limit 50;
```

Inspect recent HTTP results:

```sql
select id, status_code, timed_out, error_msg, content, created
from net._http_response
order by created desc
limit 50;
```

Operator-visible recovery lives in `invoice_execution_jobs`, invoice settlement state, `wallet_withdrawals`, and `audit_events`. Do not manually resubmit a payment or withdrawal when the prior Circle outcome is uncertain. Restore the provider/RPC dependency and let reconciliation recover the recorded transaction.

Emergency stop, in order:

1. Disable bounded autonomy for the affected business/network.
2. Pause its policy contract.
3. Revoke its USDC allowance if payment authority must be removed onchain.
4. Stop the global scheduler with `select cron.unschedule('inboxpay-autonomy');` only if all businesses must stop.

Do not delete queued jobs, withdrawal rows, invoices, or audit evidence during an incident.

## Mainnet release gate

Mainnet autonomy remains blocked until the Testnet proof above passes, the feature-branch diff receives a financial/security review, the migration and secrets are verified in Production, monitoring is active, and the business explicitly enables Arc Mainnet autonomy. A real Mainnet invoice or withdrawal requires the user's separate authorization and must be reconciled from live Circle and Arc evidence before it is described as complete.
