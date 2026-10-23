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

The `Encrypted database backup` workflow runs daily at 02:17 UTC and can be dispatched manually. It creates a custom-format dump, encrypts it with AES-256 through GnuPG, uploads the encrypted file plus SHA-256 checksum, and deletes runner-local copies. Keep the bucket private and review versioning, server-side encryption and access logging. The earlier suggestion of 35 daily copies plus monthly archives is not an approved customer-data retention policy or proof of the bucket's actual lifecycle. Confirm expiry for current objects, noncurrent versions and soft-deleted objects before promising a deletion window. Do not enable indefinite monthly archives by default.

The workflow fails closed when any required destination or encryption secret is absent. A workflow existing in GitHub is not evidence that backups are active: verify a successful run and the object in the private bucket.

For Google Cloud Storage, use a private Standard bucket in an eligible region and a dedicated service account restricted to that bucket. GitHub authenticates through Workload Identity Federation using repository-scoped OIDC claims. The workflow stores no Google service-account key or HMAC secret; every run receives short-lived credentials. Keep the organisation policy that blocks external service-account keys enabled.

Telegram is the preferred operator alert channel when both Telegram secrets are present. The generic webhook remains available as a fallback. Business-linked Telegram destinations do not receive backup failures. Backup success stays quiet; only a failed run sends an alert.

After changing either Telegram secret, manually run **Test Telegram operations alert**. A green workflow plus the received Telegram message is the delivery acceptance check; it does not access the database or perform a financial action.

## Quarterly restore drill

1. Copy the exact encrypted object URI from the private bucket.
2. Dispatch `Database restore drill`, provide that URI, and type `RESTORE_TO_DISPOSABLE_DATABASE`.
3. Confirm checksum verification, decryption, `pg_restore`, restored-Gmail credential invalidation, and the core-table assertion all pass.
4. Review the recorded table counts and perform any additional business-level checks required by the incident: tenant counts, invoice/payment references, audit-event continuity, policy rows, execution jobs, and withdrawal records.
5. Record the drill date, backup timestamp, duration, and operator in the private incident log.

The workflow starts an isolated PostgreSQL 17 service inside the ephemeral GitHub runner, restores only the application-owned `public` schema, and destroys the database and plaintext dump automatically when the runner exits. It has no configurable production database target.

The restore workflow never targets production automatically and does not use `--clean`. If the destination is not empty, the restore must fail rather than overwrite existing data.

## Restored Gmail credentials must never resume automatically

Every restored database must clear **all** stored Gmail access/refresh tokens, scopes, expiry and Google account identifiers, including rows that looked connected at the backup timestamp. This deliberately requires every business to reconnect after recovery. It covers disconnects that happened after the backup without depending on a deletion marker inside that same old backup.

The shared helper is `scripts/recovery/invalidate-restored-gmail.sql`. It retains integration IDs and invoice/payment references and makes no calls to Google, Circle or Arc. It does not alter payment settings or cancel queued payments; workers and traffic must remain stopped throughout recovery. The local regression executes the helper in an isolated embedded PostgreSQL engine with synthetic records, not production data.

The disposable drill invokes it after all restore sections, before reporting verification success. For a separately approved incident restore, independently verify the replacement database host, database name and isolation first. Then run both commands in the **same psql session**, with errors fatal:

```sql
set inboxpay.restore_mode = 'isolated';
\i scripts/recovery/invalidate-restored-gmail.sql
```

Use `psql --set=ON_ERROR_STOP=1`. Never mark or run this against a healthy production database. The setting is an intent check, not proof of isolation. Failed verification rolls back credential changes; do not resume workers or route traffic after any error. After successful cleanup, archive the aggregate verification result without token values and require fresh owner consent for Gmail.

This removes usable credentials from the restored database, not the encrypted backup object or its temporary dump. Existing backups still need an approved expiry policy and isolated handling. Workspace-data deletions also require an independent deletion ledger and restore-time reapplication before cutover; the Gmail helper alone does not solve deletion of invoices, identity or other business records. That process remains under review.

## Incident recovery order

1. Stop autonomous execution globally only when the incident affects all businesses; otherwise disable the affected business/network.
2. Preserve Circle transaction IDs, Arc hashes, job leases, withdrawals, and audit evidence.
3. Restore Supabase service if the incident is availability-only. Do not restore a backup over a healthy database.
4. For confirmed data loss, create a new controlled database with workers and traffic stopped. Restore the latest verified backup, invalidate restored Gmail credentials using the helper above, and reapply approved data deletions using an independent record. Verify these steps before any cutover. Gmail replay requires fresh consent; use Circle and Arc evidence through the normal reconciliation path without creating replacement payments.
5. Revalidate RLS, service-role-only functions, business/network isolation, and scheduler secrets before routing production traffic.
6. Reconcile every payment or withdrawal created after the backup timestamp before re-enabling autonomy.

Provider truth is authoritative for settlement. A database restore must never create a replacement payment for a Circle transaction whose final outcome is uncertain.
