# Business data requests and retention

Implementation prepared 30 October 2026. Activation is separate from deployment.
This is an operator/developer guide, not a published privacy policy.

## Customer path

When `INBOXPAY_DATA_CONTROLS_ENABLED=true`, Business account links to
`/data-controls.html`. The owner uses their existing InboxPay session, chooses
invoice-evidence removal, workspace closure or export, and acknowledges that a
request does not delete records or stop payments. The receipt contains a stable
reference and review status. Ambiguous network failures reuse the same request
ID; the database also permits only one open request per business and scope.

The API derives ownership from the authenticated account and checks the expected
business. The SQL function independently verifies `auth.uid()` and business
ownership. Only the owner may read their requests. Browser roles cannot change
status or delete request rows. Preview writes remain blocked. No payment,
autonomy, withdrawal or wallet-authority setting changes when requesting removal.

The new request states are `requested`, `reviewing`, `blocked`, and `cancelled`.
There is deliberately no completion state: full workspace removal/export is not
implemented by this intake release. A support operator must not call a request
complete because it was received or Gmail was disconnected.

## Support handling

Review new requests in the protected Supabase operator console using the
server-only request table. Do not expose this console or its credentials in the
business app. This first release does not send an automatic support notification;
assign an operator and a review cadence before enabling customer intake. Support
remains inboxpaysupport@gmail.com. Never request credentials or mailbox contents.

1. Look up the receipt and server-recorded owner/business relationship. A sender
   email or screenshot is not proof. Reconfirm the current owner's authority and
   exact scope before any data disclosure or permanent removal.
2. Explain the distinction between Gmail tokens, invoice evidence, financial
   records, workspace closure, third-party messages and public-chain records.
3. For closure, review pending Circle submissions, reconciliation, withdrawals,
   remaining wallet funds and delegated authority. Do not use cascading user or
   business deletion. Stopping payments or moving funds is a separate explicitly
   authorized action. This release does not implement it.
4. Keep broader requests blocked until the precise fields, required financial
   record exceptions and independent deletion/recovery record are approved and
   the applicable operation is tested. Do not invent a seven-year financial
   retention rule or promise an arbitrary response/erasure deadline.
5. Record operator review separately with access controls. No free-form mailbox
   contents or support narrative belongs in the request table, public issues,
   CI logs or the Telegram payment outbox. The request table contains only
   identifiers, scope, status, identity method and timestamps.

Legal response duties still apply. The narrow supported automation below does
not make broader requests optional or justify indefinite storage.

## Approved retention automation

The operator approved this exact scope on 30 October 2026:

| Data | Action and cutoff |
| --- | --- |
| Expired Telegram linking tokens | Delete rows whose expiry is more than one day ago. Live or recently expired links remain. |
| Terminal customer payment notifications | At more than 30 days since the last state update, clear payload, error text, Telegram message ID and lease fields for delivered/failed/skipped rows. Keep the row and source key as a duplicate-delivery tombstone. |
| Pending or leased delivery jobs | Never age them out with this job. |
| Invoices, payments, settlement/audit records, wallets, policies and withdrawals | No mutation. Financial retention remains a separate decision. |

`run_business_data_retention` is service-only, defaults to dry run, and bounds each
category to at most 1,000 rows per call. The runner requests 500. Applied batches
use row locks with skip-locked behavior and commit atomically; another run can
drain remaining eligible rows. Counts are per batch, not total inventory. The
redaction timestamp prevents subsequent normal updates from reactivating or
refilling a redacted job. A source-key conflict still suppresses duplicate alerts.

Run locally with credentials supplied privately through the environment:

```powershell
node scripts/privacy/run-retention.mjs
```

Apply additionally requires `INBOXPAY_RETENTION_ENABLED=true` and `--apply`.
Never put secrets in command arguments or committed files. The runner prints only
counts and mode. A timeout is not proof of rollback; rerun dry-run/readback first.

## Reviewable activation sequence

For a one-off reviewed production release, **Release data controls** is fixed to
this migration and the existing InboxPay production database connection. It uses
the protected database password already used by the financial-RLS verification
workflow; no new REST credential is needed for this path. Its default mode is
read-only dry run. Applying the schema requires `apply-and-dry-run` plus the exact
confirmation `APPLY_DATA_CONTROLS_20261030`. It records the migration source in the
existing Supabase migration ledger atomically, rejects a changed applied source,
checks privileges, then calls retention with `true` inside a read-only transaction.
It never runs retention apply or enables request intake/scheduled deletion.
The **Business data retention** workflow now uses that same protected database
connection and fixed SQL. It does not need a new REST credential. Manual apply
requires `APPLY_RETENTION_BATCH`; scheduled apply additionally requires the
repository variable `INBOXPAY_RETENTION_ENABLED=true`. The scheduled time is
03:47 UTC daily (04:47 in Lagos); GitHub may delay scheduled starts.

The fixed apply SQL captures at most 500 candidates in each category and locks
them inside a repeatable-read transaction. It verifies exact deletion/redaction
counts, retained source keys and cleared payload/error/lease fields before
committing. A mismatch rolls back. A summary receipt is printed only after commit,
followed by aggregate remaining-candidate counts. It cannot close a workspace or
change financial records or request intake. The optional local REST runner above
still requires its own private credential if used separately.

1. Review migration `20261030000000_privacy_requests_and_retention.sql` and run
   `npm run test:privacy-retention`, `test:data-request-route`, `test:data-controls`,
   `test:data-requests`, `test:gmail-disconnect` and the application regressions.
2. Deploy reviewed code and apply the migration using the normal controlled
   migration process. Keep both activation variables unset/false. There is no
   migration-time deletion and no cron installed in Supabase by this migration.
3. Confirm the existing protected `SUPABASE_DB_PASSWORD` connection and reviewed
   main-branch workflow. No credential value belongs in arguments, logs or the
   browser. Failed runs remain visible in GitHub Actions; identify the operator
   responsible for reviewing them. Do not assume external paging is configured.
4. Dispatch **Business data retention** in its default `dry-run` mode. Inspect
   aggregate counts and target environment privately. Obtain exact cleanup
   approval before manual apply with its confirmation. After verified cleanup,
   obtain schedule activation approval before setting `INBOXPAY_RETENTION_ENABLED=true`.
   Scheduled execution skips entirely while that variable is not true.
5. Verify a successful applied batch and a second dry-run. Check no eligible
   payloads remain within the drained batch and payment rows are unchanged.
6. Separately activate owner request intake in Vercel only after support handling
   is staffed. Test with two controlled owners; submitting a request does not
   authorize executing it. Publish privacy pages only after their release gates.

## Recovery

Before serving traffic or starting workers on an isolated replacement database,
run both shared helpers after restoring schema/data/constraints:

- `scripts/recovery/invalidate-restored-gmail.sql`
- `scripts/recovery/invalidate-restored-notifications.sql`

Both require the explicit isolated-restore setting; the operator must also verify
the real target and stopped traffic. The notification helper revokes every restored
customer destination, clears its identifier/hint/preferences, deletes linking
tokens and sanitizes/skips all restored customer message snapshots. It preserves
notification source keys, invoice/payment evidence and the platform's separate
operator alert configuration. Customers must reconnect their destination.

This conservative reset also handles a backup predating Telegram disconnect or
notification redaction without relying on a deletion register inside that same
backup. It does not delete messages already held by Telegram, erase public-chain
data or replay broader invoice/workspace deletion. Before broader erasure is
supported, maintain a protected independent deletion register and tested replay;
block cutover if it is unavailable. Restored request rows are historical and must
not be interpreted as a complete post-backup request register.

The existing backup lifecycle is 35 days plus seven-day soft-delete recovery;
asynchronous expiry is not a guaranteed permanent-erasure date. Actual expiry,
provider log retention, legal bases and financial-record retention require their
own evidence and decisions.
