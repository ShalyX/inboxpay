# Deployment guide

## Supported shape

- Static frontend and Vercel Node functions
- Supabase Auth and Postgres
- Gmail OAuth and Gmail API
- Circle Developer-Controlled Wallets and Smart Contract Platform
- Arc Testnet (`5042002`) and Arc Mainnet (`5042`)
- Supabase Cron plus `pg_net` for the bounded-autonomy worker

Node.js 20 or newer is required. The production repository is framework-light and has no frontend compilation step.

## Required environment variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Public/server | Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | Public/server | Browser and authenticated REST access subject to RLS. |
| `SUPABASE_SECRET_KEY` | Server | Preferred backend key for worker claims and recovery. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Legacy fallback only. |
| `GMAIL_CLIENT_ID` | Server | Google Web OAuth client. |
| `GMAIL_CLIENT_SECRET` | Server | Google Web OAuth secret. |
| `INBOXPAY_TOKEN_ENCRYPTION_KEY` | Server | Encrypts stored Gmail provider tokens. |
| `GMAIL_OAUTH_ALLOWED_ORIGINS` | Server | Optional exact HTTPS-origin list replacing the built-in canonical/legacy origins. Register each origin's `/api/gmail/callback` on the Google Web client before deployment; never use wildcard preview origins. |
| `CIRCLE_TEST_API_KEY` | Server | Circle Testnet API access. |
| `CIRCLE_TEST_ENTITY_SECRET` | Server | Circle Testnet signing entity secret. |
| `CIRCLE_LIVE_API_KEY` | Server | Circle live API access. |
| `CIRCLE_LIVE_ENTITY_SECRET` | Server | Circle live signing entity secret. |
| `ARC_TESTNET_RPC_URL` | Server | Private or dedicated Arc Testnet RPC. |
| `ARC_RPC_URL` | Server | Arc Mainnet RPC. |
| `INBOXPAY_WALLET_IDEMPOTENCY_SECRET` | Server | Deterministic wallet-operation idempotency. |
| `AUTONOMY_CRON_SECRET` | Server/Supabase Vault | Dedicated worker bearer secret. |
| `TELEGRAM_BOT_TOKEN` | Server | InboxPay-owned bot credential used for platform and opted-in business delivery. Businesses never provide this token. |
| `TELEGRAM_ALERT_CHAT_ID` | Server | Platform operator destination for business-scoped provider incidents, backup, and system failures. |
| `TELEGRAM_WEBHOOK_SECRET` | Server | Random 24+ character secret used to authenticate Telegram webhook requests. |
| `INBOXPAY_PUBLIC_URL` | Server | Canonical HTTPS origin used when registering the Telegram webhook. |
| `OPERATIONS_ALERT_WEBHOOK_URL` | Server | Optional incident and recovery notification destination. |
| `OPERATIONS_ALERT_WEBHOOK_SECRET` | Server | Optional dedicated bearer secret for the notification destination. |
| `INBOXPAY_ALLOW_MAINNET_WRITES` | Server | Must equal `true` before server-side Mainnet writes are allowed. |

`CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` remain supported as legacy Testnet fallbacks. Do not configure a global wallet ID or shared treasury address.

Provider, reconciliation, and platform system alerts use `TELEGRAM_ALERT_CHAT_ID` or the generic webhook fallback; they never use a customer chat. A business can link its own Telegram destination from **Business → Notifications** with a ten-minute, one-time deep link, then test or disconnect it. After migration `20261020000000_customer_payment_notifications` is applied, payment submission, confirmed reconciliation, failure, and payment-review transitions enqueue customer alerts only for linked businesses. The existing minute worker claims at most three per cycle, retries failed delivery at most five times, and records delivered, skipped, or terminal failure states. It checks the exact chat and link timestamp immediately before sending, skipping jobs for a disconnected or relinked destination; an already in-flight send can still race a disconnect. Chat IDs are encrypted at rest, link tokens are stored only as SHA-256 hashes, and notification tables are server-only under RLS. Telegram does not offer an idempotency key for `sendMessage`: an acknowledgement lost after successful delivery can cause a repeated message, identified by the same Alert ID. The ledger and audit trail—not Telegram—are authoritative. Never place the bot token or webhook secret in browser code or a public workflow variable.

## Database

Apply committed migrations in filename order:

1. `supabase/migrations/20261004172924_create_inboxpay_multi_user_core.sql`
2. `supabase/migrations/20261004174052_add_business_wallet_and_vendor_tenants.sql`
3. `supabase/migrations/20261004175622_add_business_policy_contract_state.sql`
4. `supabase/migrations/20261004175808_track_policy_contract_configuration.sql`
5. `supabase/migrations/20261012000000_business_network_accounts.sql`
6. `supabase/migrations/20261015000000_vendor_aware_invoice_discovery.sql`
7. `supabase/migrations/20261015010000_autonomy_and_withdrawals.sql`
8. `supabase/migrations/20261017232500_operations_service_states.sql`
9. `supabase/migrations/20261019000000_business_notification_channels.sql`
10. `supabase/migrations/20261019000001_fix_telegram_link_conflict.sql`
11. `supabase/migrations/20261020000000_customer_payment_notifications.sql`
12. `supabase/migrations/20261020000001_financial_write_boundary.sql`
13. `supabase/migrations/20261021000000_vendor_sender_audit_boundary.sql`
14. `supabase/migrations/20261030000000_privacy_requests_and_retention.sql` — data requests and bounded retention; no deletion runs during migration. Keep request intake and retention activation off until the [data-controls activation sequence](./DATA-CONTROLS.md) is approved and verified.

The first four files are the exact foundational migrations already recorded by the production Supabase project. Do not squash, renumber, or replace them. They make clean-room deployment reproducible while preserving production migration identity.

For an existing production deployment, release the server-credential invoice/audit writer code and wait until Vercel marks it Ready before applying migrations 11 and 12 together with the reviewed GitHub Actions workflow. The older application version still writes those tables as an authenticated owner and would fail after privilege revocation. The new worker tolerates an absent notification queue during this short release window, but customer payment messages will not start until the migrations are applied. Do not begin a payment in that window.

After migrations, run the manual **Verify production financial RLS** workflow. It chooses two existing owners with invoice and audit rows, then uses read-only transactions with the `authenticated` database role and each owner's JWT-sub claim to verify own-row reads, cross-owner exclusion, and denied direct financial writes. The migration workflow separately checks grants, policy shape, and history. These database checks do not replace browser/API authentication tests or real payment-alert delivery. Verify service-role claim functions reject authenticated callers.

## Google configuration

Use a Web application OAuth client. Register the canonical product origin and the callback documented in [GMAIL-SETUP.md](../GMAIL-SETUP.md). The Gmail connector requests read-only Gmail scope. Supabase Google sign-in and Gmail invoice access are separate flows even if they share one Google project.

## Build and preflight

```bash
npm ci
npm run test:profile
npm run test:gmail-parser
npm run test:local
npm run test:scheduling
npm run test:preflight
npm run test:recovery
npm run test:idempotency
npm run test:networks
npm run test:migration
npm run test:frontend
npm run test:invoice-route
npm run test:autonomy-wallet
npm run test:operations
npm run test:alerts
npm run test:database
npm run compile:policy
npm audit --omit=dev
```

Also run `forge test` when Foundry is available. A green unit/build pass does not replace the live Testnet rejection and reconciliation matrix.

## Release sequence

1. Review the diff for secrets, provider dumps, private invoice data, generated output, and unintended wallet identifiers.
2. Apply compatible database migrations before code that depends on them. For the `20261020000001` invoice/audit privilege revocation, deploy the server-writer code first, verify Ready, then apply `20261020000000` and `20261020000001` together before resuming payment operations.
3. Configure secrets in the target environment.
4. Deploy to a preview environment and run signed-out, authenticated, mobile, and provider-failure checks.
5. Deploy Production.
6. Verify `/api/config`, authentication, Gmail connection, business/network isolation, wallet and policy reads, a read-only invoice refresh, and that the business app has no operator diagnostics route.
7. Run one controlled Arc Testnet rejection case before any settlement proof.
8. Enable the scheduler only after its secret and database job are verified.
9. Keep Mainnet writes disabled unless the separate release gate is approved.

## Rollback

- Roll application code back through the hosting provider without deleting durable state.
- Do not roll back a database migration by dropping financial records.
- Disable autonomy and pause affected policy vaults before emergency application rollback.
- Preserve Circle transaction IDs, Arc hashes, idempotency keys, jobs, withdrawals, invoices, and audit events.
- Reconcile all processing records against Circle and Arc before restoring payment submission.

## Post-deployment checks

- Canonical URL and OAuth callbacks resolve over HTTPS.
- Unauthenticated protected endpoints return `401`.
- Arc RPC reports the expected chain ID for each environment.
- The active business sees only its own network account and records.
- The operator monitor persists Gmail, Circle, Arc RPC, Supabase, and reconciliation health independently and pages the configured operator destination after its threshold. The business app must not expose those diagnostics or route incidents to customer Telegram chats.
- No Mainnet financial write is performed merely as a health check.

See [AUTONOMY-RUNBOOK.md](../AUTONOMY-RUNBOOK.md) for scheduler SQL and incident recovery, and [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md) for encrypted backups and restore drills.
