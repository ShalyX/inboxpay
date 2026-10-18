# Backup and recovery

InboxPay uses encrypted logical PostgreSQL backups as an independent recovery layer. Supabase remains the live system of record; backup files never belong in the repository, Vercel, or a public CI artifact.

## Activate scheduled backups

Configure these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_DB_URL` | Production Postgres connection string used only by `pg_dump`; use the SSL session-pooler URI when the runner cannot reach the direct IPv6 endpoint. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Dedicated high-entropy backup encryption secret. Do not reuse an application credential. |
| `BACKUP_S3_URI` | Private bucket prefix such as `s3://company-inboxpay-backups/production`. |
| `BACKUP_AWS_ACCESS_KEY_ID` | Write/read credential restricted to the backup prefix. |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | Matching restricted credential. |
| `BACKUP_AWS_REGION` | Bucket region. |
| `TELEGRAM_BOT_TOKEN` | Preferred Telegram bot credential for backup-failure alerts. |
| `TELEGRAM_ALERT_CHAT_ID` | Telegram destination for backup-failure alerts. |
| `OPERATIONS_ALERT_WEBHOOK_URL` | Optional failure-notification destination. |
| `OPERATIONS_ALERT_WEBHOOK_SECRET` | Optional bearer secret for that destination. |

The `Encrypted database backup` workflow runs daily at 02:17 UTC and can be dispatched manually. It creates a custom-format dump, encrypts it with AES-256 through GnuPG, uploads the encrypted file plus SHA-256 checksum, and deletes runner-local copies. Configure bucket versioning, server-side encryption, access logging, and a retention lifecycle of at least 35 daily copies plus monthly archives.

The workflow fails closed when any required destination or encryption secret is absent. A workflow existing in GitHub is not evidence that backups are active: verify a successful run and the object in the private bucket.

Telegram is the preferred alert channel when both Telegram secrets are present. The generic webhook remains available as a fallback. Backup success stays quiet; only a failed run sends an alert.

After changing either Telegram secret, manually run **Test Telegram operations alert**. A green workflow plus the received Telegram message is the delivery acceptance check; it does not access the database or perform a financial action.

## Quarterly restore drill

1. Create an empty, disposable PostgreSQL database that is isolated from production.
2. Store its direct connection string as the `RESTORE_DATABASE_URL` GitHub Actions secret.
3. Copy the exact encrypted object URI from the private bucket.
4. Dispatch `Database restore drill`, provide that URI, and type `RESTORE_TO_DISPOSABLE_DATABASE`.
5. Confirm checksum verification, decryption, `pg_restore`, and the core-table assertion all pass.
6. Perform business-level checks: tenant counts, invoice/payment references, audit-event continuity, policy rows, execution jobs, and withdrawal records.
7. Destroy the disposable database and record the drill date, backup timestamp, duration, and operator in the private incident log.

The restore workflow never targets production automatically and does not use `--clean`. If the destination is not empty, the restore must fail rather than overwrite existing data.

## Incident recovery order

1. Stop autonomous execution globally only when the incident affects all businesses; otherwise disable the affected business/network.
2. Preserve Circle transaction IDs, Arc hashes, job leases, withdrawals, and audit evidence.
3. Restore Supabase service if the incident is availability-only. Do not restore a backup over a healthy database.
4. For confirmed data loss, create a new controlled database, restore the latest verified backup, then replay provider truth from Gmail, Circle, and Arc into the normal reconciliation path.
5. Revalidate RLS, service-role-only functions, business/network isolation, and scheduler secrets before routing production traffic.
6. Reconcile every payment or withdrawal created after the backup timestamp before re-enabling autonomy.

Provider truth is authoritative for settlement. A database restore must never create a replacement payment for a Circle transaction whose final outcome is uncertain.
