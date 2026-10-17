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
| `CIRCLE_TEST_API_KEY` | Server | Circle Testnet API access. |
| `CIRCLE_TEST_ENTITY_SECRET` | Server | Circle Testnet signing entity secret. |
| `CIRCLE_LIVE_API_KEY` | Server | Circle live API access. |
| `CIRCLE_LIVE_ENTITY_SECRET` | Server | Circle live signing entity secret. |
| `ARC_TESTNET_RPC_URL` | Server | Private or dedicated Arc Testnet RPC. |
| `ARC_RPC_URL` | Server | Arc Mainnet RPC. |
| `INBOXPAY_WALLET_IDEMPOTENCY_SECRET` | Server | Deterministic wallet-operation idempotency. |
| `AUTONOMY_CRON_SECRET` | Server/Supabase Vault | Dedicated worker bearer secret. |
| `INBOXPAY_ALLOW_MAINNET_WRITES` | Server | Must equal `true` before server-side Mainnet writes are allowed. |

`CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` remain supported as legacy Testnet fallbacks. Do not configure a global wallet ID or shared treasury address.

## Database

Apply committed migrations in filename order:

1. `supabase/migrations/20261012_business_network_accounts.sql`
2. `supabase/migrations/20261015_vendor_aware_invoice_discovery.sql`
3. `supabase/migrations/20261015_autonomy_and_withdrawals.sql`

These are incremental migrations. They do not create the foundational InboxPay schema from an empty project. A clean deployment must first apply the canonical baseline schema from the controlled production schema export. That baseline is not yet committed, so independent clean-room deployment is currently blocked and must not be improvised.

After migrations, verify RLS as an authenticated user from two separate accounts and verify that service-role claim functions reject authenticated callers.

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
npm run compile:policy
npm audit --omit=dev
```

Also run `forge test` when Foundry is available. A green unit/build pass does not replace the live Testnet rejection and reconciliation matrix.

## Release sequence

1. Review the diff for secrets, provider dumps, private invoice data, generated output, and unintended wallet identifiers.
2. Apply database migrations before code that depends on them.
3. Configure secrets in the target environment.
4. Deploy to a preview environment and run signed-out, authenticated, mobile, and provider-failure checks.
5. Deploy Production.
6. Verify `/api/config`, authentication, Gmail connection, business/network isolation, wallet and policy reads, Operations health, and a read-only invoice refresh.
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
- Operations health reports Gmail, Circle, Arc RPC, Supabase, and reconciliation independently.
- No Mainnet financial write is performed merely as a health check.

See [AUTONOMY-RUNBOOK.md](../AUTONOMY-RUNBOOK.md) for scheduler SQL and incident recovery.
