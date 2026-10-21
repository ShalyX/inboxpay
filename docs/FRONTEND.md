# Frontend presentation and verification

## Correspondence direction

InboxPay's customer-facing job is handling invoices and USDC payments from Gmail. Lead with the invoice, next action, and payment record. Payment limits, authorization, vendor verification, and reconciliation remain real requirements; the presentation does not change those requirements.

The static frontend uses `public/index.html` and `public/inboxpay.js`. `public/correspondence.css` supplies the current tokens and component presentation over the legacy form/destination styles. The legacy stylesheet is retained for controls not yet migrated; consolidating it should be a dedicated, visually verified follow-up, not an untested deletion.

- Public landing: product explanation, clearly labelled illustrative invoices, sign-in dialog, and early-access availability note.
- Business help: `/help.html`, separate from developer documentation.
- Workspace: full-width invoice queue, combined search/filter controls, business/network context, and optional account details with the full wallet address.
- Invoice detail: native modal dialog, right-aligned on desktop and full-width on phones. Escape/close/backdrop dismiss it without resetting search or selection. The dialog restores focus even when a preflight refresh replaces the original row.
- Payment checks: visible on blocked invoices; expandable for eligible or already reconciled invoices. Eligibility, confirmation, financial API payloads, and reconciliation rules are not bypassed.
- Other destinations: exclusive pages using the existing destination controller, not stacked dialogs.

## Read-only authenticated previews

Vercel Preview deployments automatically enable a server-enforced QA boundary (`VERCEL_ENV=preview`). Local QA can opt in with `INBOXPAY_PREVIEW_READ_ONLY=true`. Production behavior is unchanged unless that explicit override is set.

The preview reads saved owner-scoped business/invoice records using the signed-in user's Supabase token and RLS. It does not scan Gmail, queue payments, reconcile transactions, connect Telegram, or accept financial/configuration writes. Ordinary sign-in bootstrap may load an existing business and initialize its network account and draft policy. A new business requires an explicit name and cannot be created in the preview. Saved policy status is not fresh provider verification.

Only public Supabase configuration is needed. Never copy production Circle credentials, Gmail encryption keys, worker secrets or service-role keys into a visual QA preview. Gmail connection/callback and notification destinations are disabled there. Public Arc reads may still supply wallet/preflight information; their availability does not enable payment submission.

Authentication requires the exact preview return URL in Supabase's redirect allowlist. Preserve the production Site URL and existing redirects; do not add broad wildcards. Run `npm run test:preview` to check rejected writes and the saved-record invoice GET path. Preview inspection is not evidence of live Gmail processing or financial settlement.

## Local verification

Run the application with the documented environment contract. For example, with a private local environment file:

```powershell
$env:PORT = '3013'
node --env-file=.env.local dev-server.mjs
```

Do not commit that environment file. Google/Supabase must return authentication to the local or preview origin; a redirect back to the production site does not authenticate localhost.

For deterministic visual states without credentials or financial actions:

```powershell
node scripts/verification/frontend-fixture-server.mjs
```

This binds to loopback on port 3014 and serves the real frontend with explicitly labelled fixtures. It substitutes only the local authentication/provider responses; no real Gmail, Circle, Arc, or Supabase connection exists. Payment/configuration writes are rejected. It is outside `public/`, is not an application feature, and must never be used as evidence of integration or settlement success.

Fixture URLs: `/`, `/?fixture=empty`, `/?fixture=error`, and `/?fixture=disconnected`. The latter three exercise empty evaluation, service failure, and disconnected Gmail. No such query switches exist in the production application.

Regression checks:

```powershell
npm run test:frontend
npm run test:local
```

The frontend check covers destination isolation, query categories, single-flight connections, unique IDs, dialog scroll/focus lifecycle, and refreshed-row focus fallback. The server check verifies static modules, font/image/manifest MIME types, help assets, and unauthenticated API rejection. Run the other `test:*` suites before release as well.

## Review status — 2026-10-21

All 19 repository regression scripts passed, including the new business-name onboarding checks, preview write boundary and saved-record invoice-query path. Browser inspection covered the real local public landing, sign-in dialog Escape/focus restoration, business help, phone-width layout, and isolated-fixture invoice/search/drawer/error/disconnected/navigation states. The inspected drawer prevented background interaction and retained the filtered queue on close.

This implementation has not been deployed. After explicit founder approval, the exact `http://localhost:3015/` return URL was added to Supabase; the production Site URL and redirect were preserved. Authenticated read-only QA now shows Caraxes Labs' real saved invoices, receipt/payment records, business addresses, and vendor registry. Invoice search and Escape/focus restoration were verified, and secondary destinations remained isolated. Preview-unavailable Telegram status, vendor-load failures, completed-job wording, and drawer reopening position were corrected. All 18 regression scripts passed after these changes. No financial configuration or payment was changed.

The second authenticated account returned to the isolated local origin with an empty business, no wallet or deployed vault, and an empty vendor registry. The UI now shows the signed-in email on desktop and phones. New owners must supply a business name before bootstrap creates records; unconfigured legacy email-domain names receive a review prompt. No existing business is automatically renamed. Preview forms remain disabled, so no live name save was performed. Tests cover missing/invalid names, successful creation and repeated bootstrap without renaming. Startup failures show a persistent retry notice rather than an empty setup result.

Public Gmail access, a full live onboarding save, and direct adversarial two-account RLS checks remain unverified. A cloud Preview upload is blocked by a recurring TLS transport error, not a confirmed build failure. The local QA boundary does not prove live Gmail scanning or payment execution.

The selected identity direction is implemented for review; final logo/collision clearance and regeneration of legacy X/lockup assets remain separate brand work.
