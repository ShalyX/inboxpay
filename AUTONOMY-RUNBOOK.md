# InboxPay autonomy and business-funds runbook

This runbook applies to the bounded autonomous-payment worker, business-wallet withdrawals, service health checks, and durable recovery queues on `main`. It does not authorize a Mainnet payment, withdrawal, allowance, vendor registration, or contract migration by itself.

## Safety model

- Autonomy is disabled by default and enabled per business and Arc network only after explicit owner confirmation.
- Only one network can have standing autonomous authority for a business at a time.
- Each due payment rechecks the live invoice decision, business/network ownership, verified vendor, onchain policy, allowance, duplicate marker, per-payment and daily limits, cash floor, and pause state.
- The worker reuses the existing payment idempotency and reconciliation path. A delayed Circle or Arc result remains reconciling and is not submitted again as a new payment.
- Withdrawals originate only from the business's dedicated Circle wallet. They preserve the cash floor, reserve funds for active autonomous jobs, require an exact user confirmation, and remain pending until Circle plus the Arc receipt agree.
- `BusinessPolicyVault` is allowance-based and does not custody a separate balance. Its `vaultBalance()` reports the owner wallet balance, so there is no policy-vault-to-wallet withdrawal to expose.

## Required database change

Apply `supabase/migrations/20261015010000_autonomy_and_withdrawals.sql` in the production Supabase project before deploying the application code.

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

### Operator view

The server-side monitor performs read-only, business-scoped checks for:

- Gmail authorization and profile reachability without scanning or storing message content;
- the active environment's dedicated Circle wallet and USDC asset;
- the expected Arc chain ID through the configured RPC;
- Supabase access to the business's durable payment, withdrawal, and reconciliation records;
- unresolved reconciliation work, split into bounded automatic recovery and operator attention.

The worker records these service states every five minutes per business and environment. Two consecutive provider failures are required before an operator page, which suppresses transient noise. A stopped reconciliation record is immediately alertable. Recovery is paged once after a previously delivered incident, and repeat failure pages are limited to one per 30 minutes. Concurrent workers conditionally claim each delivery to prevent duplicates. `TELEGRAM_ALERT_CHAT_ID` or `OPERATIONS_ALERT_WEBHOOK_URL` is the operator destination for both business-scoped provider incidents and platform-wide failures. Customer Telegram destinations are never used for these incidents. If no operator destination is configured, the state remains persisted and delivery remains pending; this is an operational gap to correct, not a customer alert.

The health request never creates a wallet, refreshes the invoice queue, submits a payment, registers a vendor, changes a policy, approves USDC, or switches the active environment. Gmail access-token refresh may occur when the saved short-lived token has expired; this preserves the existing read-only OAuth connection and does not broaden its scope.

Interpret the states as follows:

- **Healthy** — the dependency is reachable and its expected identity is verified.
- **Recovering** — a previously recorded transaction or job remains inside its bounded retry/reconciliation window. Do not resubmit it manually.
- **Needs attention** — execution stopped safely, the recovery window expired, authorization needs renewal, or an operator decision is required.
- **Unavailable** — the live dependency check failed or returned an unexpected chain. Treat payment authorization as blocked until the check recovers.

After correcting a dependency, inspect the next worker result and `operations_service_states` for that business and network. A healthy monitor state is evidence of a fresh read only; it is not evidence that a payment was submitted or settled.

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

### Incident playbooks

**Gmail**

1. If the monitor reports authorization renewal, ask the affected business to reconnect Gmail from its own account.
2. If Gmail is unavailable, do not broaden the search query or replace live ingestion with fixtures. Retry after the provider recovers.
3. Confirm a fresh invoice evaluation and its audit evidence after recovery. Gmail failure does not change wallet or policy state.

**Circle**

1. Stop new payment authorization for the affected environment while the wallet check is unavailable.
2. Preserve every stored Circle transaction ID and idempotency key. Never create a replacement submission solely because a status read timed out.
3. Restore provider access, then allow the existing reconciliation path to resolve the recorded transaction.

**Arc RPC**

1. Confirm the endpoint returns chain ID `5042002` for Arc Testnet or `5042` for Arc Mainnet.
2. Treat the wrong chain or an unavailable receipt as a hard block. Do not fall back from Mainnet to Testnet or vice versa.
3. After RPC recovery, reconcile the existing hash before permitting any retry.

**Supabase**

1. Treat an unreadable durable queue as a financial-operations block even if Gmail, Circle, or Arc is healthy.
2. Restore project/API availability and verify business/network RLS isolation before restarting the worker.
3. Do not delete or hand-edit recovery rows to force a green state.

**Reconciliation**

1. `retry`, `reconciling`, recent `leased`, and recent `processing` states stay in bounded recovery.
2. `held`, `failed`, `review`, or states older than the recovery window require operator review.
3. Compare the stored Circle transaction, Arc receipt, vendor balance/event, payment ID, and invoice state. Mark complete only when the evidence agrees.

Emergency stop, in order:

1. Disable bounded autonomy for the affected business/network.
2. Pause its policy contract.
3. Revoke its USDC allowance if payment authority must be removed onchain.
4. Stop the global scheduler with `select cron.unschedule('inboxpay-autonomy');` only if all businesses must stop.

Do not delete queued jobs, withdrawal rows, invoices, or audit evidence during an incident.

## Mainnet release gate

Mainnet autonomy remains blocked until the Testnet proof above passes, the feature-branch diff receives a financial/security review, the migration and secrets are verified in Production, monitoring is active, and the business explicitly enables Arc Mainnet autonomy. A real Mainnet invoice or withdrawal requires the user's separate authorization and must be reconciled from live Circle and Arc evidence before it is described as complete.
