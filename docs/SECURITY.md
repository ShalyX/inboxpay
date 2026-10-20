# Security model

## Scope

InboxPay coordinates real business email evidence and programmable USDC wallets. A defect can disclose invoice data, confuse business boundaries, or move funds. Financial writes therefore fail closed when identity, network, provider, or reconciliation evidence is incomplete.

Security reports should not include credentials, Gmail content, private business data, or unredacted provider responses in a public issue. Until a dedicated security mailbox exists, contact the repository owner privately through the GitHub profile.

## Authority model

- Supabase Auth identifies the user.
- A business row binds the authenticated owner to one business identity.
- Each Arc environment has a separate business network account, Circle wallet, policy vault, policy, vendors, invoices, and audit state.
- Gmail OAuth tokens are encrypted before persistence and used only on the server.
- Circle entity secrets and API keys remain server-side.
- The autonomy worker uses a dedicated bearer secret that grants only worker invocation, not Supabase or Circle access by itself.
- Mainnet writes require both server configuration and action-specific user confirmation.
- The policy vault is the final onchain authority for payment recipient, limits, cash floor, pause, and duplicate payment ID.

## Trust boundaries

| Boundary | Untrusted input | Required control |
| --- | --- | --- |
| Browser to API | Session token, network, invoice/vendor identifiers, amounts, confirmations | Authenticate every protected request; reload business ownership server-side; compare expected network; validate amounts and addresses. |
| Gmail to evaluator | Sender names, bodies, HTML, attachments, filenames | Bounded discovery routes, verified sender matching, deterministic parsing, text-PDF limits, no HTML execution, review on ambiguity. |
| API to Supabase | User-scoped and service-role operations | RLS for authenticated access; narrow service-role functions for leases, claims, and withdrawals. |
| API to Circle | Wallet IDs, transaction requests, provider status | Wallet must belong to the active business/network; deterministic idempotency; persist provider ID; never interpret timeout as safe retry. |
| API to Arc | RPC responses, receipts, logs, chain identity | Verify chain ID, policy address, transaction target, event fields, payment ID, amount, recipient, and receipt success. |
| Agent decision to settlement | `PAY_NOW` or scheduled state | Re-run deterministic server and onchain preflight immediately before submission. |

## Onchain enforcement

`BusinessPolicyVault` enforces:

- registered vendor recipient;
- maximum amount per payment;
- UTC-day spending limit;
- owner-wallet cash floor;
- emergency pause;
- one-time payment ID.

Invoice extraction, Gmail sender verification, evidence confidence, currency selection, wallet/provider readiness, and reconciliation are application controls. They must not be described as contract enforcement.

## Secrets

Never commit or expose:

- Circle API keys or entity secrets;
- Supabase secret/service-role keys;
- Gmail OAuth client secret, access token, or refresh token;
- `INBOXPAY_TOKEN_ENCRYPTION_KEY`;
- `AUTONOMY_CRON_SECRET`;
- local credential files, invoice downloads, provider dumps, or browser session data.

Use separate Testnet and live Circle credentials. Rotate the token-encryption key only through a migration that can decrypt and re-encrypt existing provider tokens. Rotate the worker secret in Vercel and Supabase Vault together.

## Primary threats and controls

| Threat | Current control | Remaining work |
| --- | --- | --- |
| Cross-business or cross-network payment | Server-side ownership reload, network match, business-scoped records, dedicated wallets and vaults | Add multi-user role and approval controls before team access. |
| Forged invoice sender | Verified sender list plus vendor registry; unmatched messages remain review-only | Add full vendor onboarding and recipient-change verification. |
| Duplicate payment | Durable claim/idempotency plus onchain used-payment marker; concurrency and recovery regressions run in CI | Continue controlled live recovery drills. |
| Provider timeout causing resubmission | Persist Circle ID and reconcile original attempt; operator Telegram alerts cover stopped reconciliation | Add measurable reconciliation-age thresholds and paging escalation. |
| Compromised browser session | Server never trusts client wallet/policy identity | Add device/session management and step-up authentication for high-value actions. |
| Malicious PDF or HTML | Text extraction, no HTML execution, parse failures become review events | Add file-size/page limits and malware scanning before broader upload support. |
| Mainnet action by mistake | Explicit Mainnet confirmations and server write gate | Add organizational approval policy and release controls. |
| Secret leakage | `.gitignore`, server-only variables, and a full-history Gitleaks CI scan | Rotate any exposed credential; scanning cannot make an already-published secret safe. |

## Incident response

For a financial incident:

1. Disable autonomy for the affected business/network.
2. Pause its policy contract.
3. Revoke the policy vault's USDC allowance if authority must be removed onchain.
4. Preserve invoices, audit events, Circle IDs, transaction hashes, execution jobs, and withdrawal rows.
5. Stop the global scheduler only if all businesses must stop.
6. Reconcile the existing transaction before permitting a retry.

The detailed provider and reconciliation procedures are in [AUTONOMY-RUNBOOK.md](../AUTONOMY-RUNBOOK.md).

## Known security limitations

- The current product is owner-operated; it does not yet implement team roles or maker-checker approval.
- The repository contains an ordered clean-room database migration set. Production database privilege checks are automated, but a live two-owner RLS smoke test must also pass after financial-boundary changes.
- Application regressions and production-dependency auditing run in CI; contract tests run in the policy-vault workflow. The full-history secret scan runs on pushes and pull requests. These checks do not replace a staging environment or live provider/reconciliation drills.
- Operator Telegram alerts and encrypted off-site backups are active; customer payment alerts require a real event-delivery acceptance test before being described as proven end to end.
- There is no published privacy policy, retention policy, or account-deletion workflow yet.

## Business notification isolation

InboxPay uses one operator-owned Telegram bot, but it does not use one shared customer destination. A business owner creates a short-lived, one-time link in the authenticated product and starts the bot in the intended Telegram chat. Only the link hash is stored while pending. After consumption, the Telegram chat ID is encrypted with `INBOXPAY_TOKEN_ENCRYPTION_KEY`; browser responses expose only a masked hint.

The notification tables have RLS enabled and grant no access to `anon` or `authenticated`. Only server-side routes using the Supabase secret may resolve or decrypt a destination. The customer payment outbox is likewise server-only and accepts only payment audit events written with the server credential after checking matching invoice settlement state. Migration `20261020000001_financial_write_boundary.sql` also removes direct `authenticated` writes to `invoices` and `audit_events`; the owner can still read their own rows through RLS, while authenticated API routes perform scoped writes with the server credential. It snapshots the recorded event and checks the exact business, owner, chat identity, and link timestamp again before sending. It does not queue history from before connection. Provider and reconciliation incidents always use the separately configured operator destination, never a business Telegram chat. Telegram delivery is a notification convenience, not payment authorization or settlement proof.
