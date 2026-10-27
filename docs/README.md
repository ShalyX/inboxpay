# InboxPay documentation

InboxPay helps businesses handle invoices and USDC payments from Gmail. This index covers the technical implementation. Start with the [business guide](https://inboxpay.vercel.app/help.html) for the customer workflow, or the [repository README](../README.md) for recorded payment proof and current availability.

- [Architecture](./ARCHITECTURE.md) — components, data flow, trust boundaries, and settlement lifecycle.
- [Security](./SECURITY.md) — authority model, threat model, secrets, and incident controls.
- [Deployment](./DEPLOYMENT.md) — environments, required configuration, database migrations, release, and rollback.
- [API](./API.md) — authenticated server endpoints and financial confirmation rules.
- [Brand assets](./BRAND.md) — identity idea, asset inventory, colors, and usage rules.
- [Frontend presentation](./FRONTEND.md) — Correspondence components, local visual fixtures, and verification boundaries.
- [Landing media](./MEDIA.md) — photographic sources, licenses, playback behavior, and asset budgets.
- [Operations runbook](../AUTONOMY-RUNBOOK.md) — worker health, recovery, and emergency response.
- [Backup and recovery](./BACKUP-RECOVERY.md) — encrypted off-site backups and disposable restore drills.
- [Gmail setup](../GMAIL-SETUP.md) — Google OAuth configuration and invoice ingestion.

## Evidence boundary

The complete autonomous AP loop has been proven on Arc Testnet. Arc Mainnet has a deployed policy vault and a separate x402 transaction, but InboxPay does not claim a genuine Mainnet invoice settlement.

## Database setup

The repository contains the foundational migrations and subsequent changes under [`supabase/migrations`](../supabase/migrations/). Apply them in filename order using the [deployment guide](./DEPLOYMENT.md). Preserve the production migration identities; do not squash or replace the historical baseline when updating an existing installation. Database reproducibility checks do not establish live provider configuration or Google verification.
