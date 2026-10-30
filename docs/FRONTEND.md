# Frontend presentation and verification

## Gmail connection disclosure — 2026-10-27

Local follow-up: every workspace Connect/Reconnect Gmail entry opens an accessible disclosure before requesting `/api/gmail/start`. It identifies the business, explains Google's mailbox-wide read permission and the application filters, lists stored connection/invoice records, and links to the business help data controls. Only Continue requests authorization. Cancel, Escape or backdrop dismissal abort an in-flight start; late responses and account/business changes cannot redirect. Errors remain in the dialog for an explicit retry. Read-only previews cannot start this flow.

The help page describes token removal, the separate Google grant, retained invoice/payment records and the support route for data-removal questions. This technical disclosure is not a published privacy policy or Google verification approval. No new permissions, payment actions or database changes accompany it.

Verification: frontend handler checks exercise cancellation, late responses, duplicate Continue clicks, error/retry, business changes, redirect-host validation and preview rejection. The local UI fixture is available at `http://localhost:3014/?fixture=disconnected`. See the workspace verification below for the subsequent rendered review.

## Correspondence direction

InboxPay's customer-facing job is handling invoices and USDC payments from Gmail. Lead with the invoice, next action, and payment record. Payment limits, authorization, vendor verification, and reconciliation remain real requirements; the presentation does not change those requirements.

The static frontend uses `public/index.html` and `public/inboxpay.js`. `public/workspace-layout.js` composes the existing controls into the workspace; `public/workspace.css` owns its layout and responsive behavior. `public/correspondence.css` supplies shared tokens and presentation over legacy form styles. Financial handlers remain in `inboxpay.js`.

- Public landing: product explanation, clearly labelled illustrative invoices, sign-in dialog, and early-access availability note.
- Business help: `/help.html`, separate from developer documentation.
- Workspace: Invoices, Payments, Vendors, Setup and Settings are distinct destinations. Settings has Business details, Payment settings, Notifications and Activity tabs. Network context and the full wallet address remain accessible through Account.
- Invoice detail: an inline side panel above 1100px; a native modal sheet on tablet and phone. Escape/close/backdrop dismiss it without resetting search or selection. Resizing switches presentation without losing the selected invoice. The dialog restores focus even when a preflight refresh replaces the original row.
- Mobile: bottom navigation, stacked ledger/registry rows and a full-width invoice sheet. The network selector keeps the complete network name visible. Settings tabs scroll within their own rail.
- Invoice status: Pending, Failed, Confirmed and Reconciled are separate states. Ready is a review queue, not permission to bypass live preflight. Source cards identify recorded metadata; they do not claim to serve original email or PDF files.
- Payment checks: visible on blocked invoices; expandable for eligible or already reconciled invoices. Eligibility, confirmation, financial API payloads, and reconciliation rules are not bypassed.
- Other destinations: exclusive pages using the existing destination controller, not stacked dialogs.

## Workspace verification — 2026-10-30

Rendered in the in-app browser against the loopback-only fixture at desktop, tablet and phone widths (1440, 1280, 1024, 390 and 320px). Checked page isolation, Settings hierarchy, invoice selection, modal-to-inline resizing, Escape/focus return, network visibility, and horizontal overflow. Corrected inherited invoice-amount grid placement, aligned attention counts with the queue, and kept account controls reachable on short desktop screens. Fixtures are visual evidence only; this review does not prove Gmail discovery or settlement.

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

## Payment-access follow-up — 2026-10-22

The current local follow-up stacks payment-access copy and buttons at desktop and phone widths, correcting the emergency-pause overlap seen in the hosted preview. Read-only previews label USDC allowance as not checked rather than unauthorized; live authorized/unauthorized labels and financial actions remain unchanged. The frontend regression check exercises those three states. All 19 regression scripts passed, and the corrected interface was inspected at 1304px and 390px using the explicitly labelled local fixture (`/?fixture=preview#policy`). This verifies presentation only, not real provider calls. These follow-up fixes are not yet committed or deployed.

## Earlier review status — 2026-10-21

All 19 repository regression scripts passed, including the new business-name onboarding checks, preview write boundary and saved-record invoice-query path. Browser inspection covered the real local public landing, sign-in dialog Escape/focus restoration, business help, phone-width layout, and isolated-fixture invoice/search/drawer/error/disconnected/navigation states. The inspected drawer prevented background interaction and retained the filtered queue on close.

This implementation has not been deployed. After explicit founder approval, the exact `http://localhost:3015/` return URL was added to Supabase; the production Site URL and redirect were preserved. Authenticated read-only QA now shows Caraxes Labs' real saved invoices, receipt/payment records, business addresses, and vendor registry. Invoice search and Escape/focus restoration were verified, and secondary destinations remained isolated. Preview-unavailable Telegram status, vendor-load failures, completed-job wording, and drawer reopening position were corrected. All 18 regression scripts passed after these changes. No financial configuration or payment was changed.

The second authenticated account returned to the isolated local origin with an empty business, no wallet or deployed vault, and an empty vendor registry. The UI now shows the signed-in email on desktop and phones. New owners must supply a business name before bootstrap creates records; unconfigured legacy email-domain names receive a review prompt. No existing business is automatically renamed. Preview forms remain disabled, so no live name save was performed. Tests cover missing/invalid names, successful creation and repeated bootstrap without renaming. Startup failures show a persistent retry notice rather than an empty setup result.

Public Gmail access, a full live onboarding save, and direct adversarial two-account RLS checks remain unverified. A cloud Preview upload is blocked by a recurring TLS transport error, not a confirmed build failure. The local QA boundary does not prove live Gmail scanning or payment execution.

The selected identity direction is implemented for review; final logo/collision clearance and regeneration of legacy X/lockup assets remain separate brand work.
