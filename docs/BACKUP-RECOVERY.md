# Backup and recovery

InboxPay uses encrypted logical PostgreSQL backups as an independent recovery layer. Supabase remains the live system of record; backup files never belong in the repository, Vercel, or a public CI artifact.

## Activate scheduled backups

Configure these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_DB_PASSWORD` | Production Postgres password used only by `pg_dump`. The workflow fixes the session-pooler host, database, SSL mode, and project-scoped username so operators do not have to construct or URL-encode a connection URI. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Dedicated high-entropy backup encryption secret. Do not reuse an application credential. |
| `TELEGRAM_BOT_TOKEN` | Preferred Telegram bot credential for backup-failure alerts. |
| `TELEGRAM_ALERT_CHAT_ID` | Telegram destination for backup-failure alerts. |
| `OPERATIONS_ALERT_WEBHOOK_URL` | Optional failure-notification destination. |
| `OPERATIONS_ALERT_WEBHOOK_SECRET` | Optional bearer secret for that destination. |

Configure these GitHub Actions repository variables:

| Variable | Purpose |
| --- | --- |
| `BACKUP_GCS_URI` | Private Google Cloud Storage prefix, currently `gs://inboxpay-prod-backups-tameion-ap-agent/production`. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full Google Workload Identity Provider resource name trusted only for `ShalyX/inboxpay`. |
| `GCP_BACKUP_SERVICE_ACCOUNT` | Dedicated bucket-scoped service account used through short-lived impersonation. |

The `Encrypted database backup` workflow runs daily at 02:17 UTC and can be dispatched manually. It creates a custom-format dump, encrypts it with AES-256 through GnuPG, uploads the encrypted file plus SHA-256 checksum, and deletes runner-local copies. Configure bucket versioning, server-side encryption, access logging, and a retention lifecycle of at least 35 daily copies plus monthly archives.

The workflow fails closed when any required destination or encryption secret is absent. A workflow existing in GitHub is not evidence that backups are active: verify a successful run and the object in the private bucket.

For Google Cloud Storage, use a private Standard bucket in an eligible region and a dedicated service account restricted to that bucket. GitHub authenticates through Workload Identity Federation using repository-scoped OIDC claims. The workflow stores no Google service-account key or HMAC secret; every run receives short-lived credentials. Keep the organisation policy that blocks external service-account keys enabled.

Telegram is the preferred operator alert channel when both Telegram secrets are present. The generic webhook remains available as a fallback. Business-linked Telegram destinations do not receive backup failures. Backup success stays quiet; only a failed run sends an alert.

After changing either Telegram secret, manually run **Test Telegram operations alert**. A green workflow plus the received Telegram message is the delivery acceptance check; it does not access the database or perform a financial action.

## Quarterly restore drill

1. Copy the exact encrypted object URI from the private bucket.
2. Dispatch `Database restore drill`, provide that URI, and type `RESTORE_TO_DISPOSABLE_DATABASE`.
3. Confirm checksum verification, decryption, `pg_restore`, and the core-table assertion all pass.
4. Review the recorded table counts and perform any additional business-level checks required by the incident: tenant counts, invoice/payment references, audit-event continuity, policy rows, execution jobs, and withdrawal records.
5. Record the drill date, backup timestamp, duration, and operator in the private incident log.

The workflow starts an isolated PostgreSQL 17 service inside the ephemeral GitHub runner, restores only the application-owned `public` schema, and destroys the database and plaintext dump automatically when the runner exits. It has no configurable production database target.

The restore workflow never targets production automatically and does not use `--clean`. If the destination is not empty, the restore must fail rather than overwrite existing data.

## Incident recovery order

1. Stop autonomous execution globally only when the incident affects all businesses; otherwise disable the affected business/network.
2. Preserve Circle transaction IDs, Arc hashes, job leases, withdrawals, and audit evidence.
3. Restore Supabase service if the incident is availability-only. Do not restore a backup over a healthy database.
4. For confirmed data loss, create a new controlled database, restore the latest verified backup, then replay provider truth from Gmail, Circle, and Arc into the normal reconciliation path.
5. Revalidate RLS, service-role-only functions, business/network isolation, and scheduler secrets before routing production traffic.
6. Reconcile every payment or withdrawal created after the backup timestamp before re-enabling autonomy.

Provider truth is authoritative for settlement. A database restore must never create a replacement payment for a Circle transaction whose final outcome is uncertain.
