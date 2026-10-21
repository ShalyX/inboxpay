# InboxPay documentation

InboxPay is a production-oriented accounts-payable operator. These documents describe the shipped system and its operating boundaries.

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

## Known infrastructure limitation

The committed Supabase migrations are incremental and assume that the foundational `businesses`, `policies`, `vendors`, `integrations`, `invoices`, and `audit_events` tables already exist. A canonical clean-room baseline migration is still required before an independent deployment can be reproduced from an empty Supabase project. Do not infer or improvise that schema from API calls in a production deployment.
