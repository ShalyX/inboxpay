# InboxPay — Agent Handoff

> **Purpose:** This file is the continuity layer for moving InboxPay development from this conversation into Codex. Read this before making changes. Treat it as the project's operational context, not as a generic README.

## 0. Read this first

InboxPay is a **real product intended to ship**, not a mock/demo architecture.

The product is an autonomous accounts-payable operator for real businesses:

**real business Gmail inbox → invoice evidence → extraction → bounded agent decision → policy checks → Circle developer-controlled business wallet → USDC settlement on Arc Mainnet → reconciliation/receipt**

The most important product constraint is:

> **Every business gets its own InboxPay account, its own Gmail connection, its own vendor registry, its own AP policy, and its own dedicated Circle developer-controlled wallet.**

Do not regress the product to a shared/global treasury wallet, fake invoice fixtures, pasted Gmail tokens, or a synthetic demo flow.

The user wants Codex to take over implementation **without losing context**. Do not ask the user to repeat information already captured here. Start by inspecting the current repository state and this handoff file, then continue from the current state.

---

## 1. Product / hackathon context

### Product
**InboxPay — Autonomous AP**

Core job:
- Read invoices from the business's real Gmail inbox.
- Extract vendor, invoice number, amount, currency, due date and evidence.
- Check duplicates, currency, vendor registry and business policy.
- Produce bounded decisions:
  - `PAY_NOW`
  - `HOLD`
  - `ESCALATE`
  - `SCHEDULE`
- Only approved USDC invoices can enter settlement.
- Settlement is performed from that business's dedicated Circle developer-controlled wallet.
- The policy guard is an onchain `PaymentPolicyVault`.
- Reconcile the Arc transaction and show a receipt/audit trail.

### Event
This build is for the **Tameion Agents Hackathon / Canteen × Circle / Arc** track.

The product is expected to demonstrate genuine business usage and real USDC activity. The production path intentionally requires a real connected business inbox.

---

## 2. Non-negotiable product principles

1. **Per-business isolation**
   - Never select a single global treasury wallet at runtime.
   - Business `owner_user_id` is unique.
   - Wallet and policy-vault state lives in `business_network_accounts`, uniquely keyed by `(business_id, network)`.
   - `businesses.active_network` selects which isolated Arc environment is projected into the runtime business context. Legacy wallet fields remain unchanged as migration evidence and rollback compatibility; runtime financial writes must not use them.

2. **Real integrations**
   - Production invoice ingestion comes from a real connected Gmail account.
   - Users do not paste OAuth secrets/tokens.
   - Provider tokens are encrypted server-side.

3. **Bounded autonomy**
   - The LLM/agent does not receive unrestricted spending authority.
   - Payment is gated by deterministic checks and the onchain policy vault.

4. **Explicit mainnet actions**
   - Creating a business wallet on Arc Mainnet requires explicit confirmation.
   - Mainnet policy deployment requires explicit confirmation.
   - Mainnet USDC approval requires explicit confirmation.
   - Do not silently turn a read/bootstrap action into a mainnet write.

5. **No fake success**
   - Never claim a payment is settled until the actual transaction and reconciliation state support it.
   - Never invent invoice evidence, balances, vendor verification, transaction hashes, or integrations.

6. **Production quality**
   - Error states should be understandable.
   - Authentication failures must not masquerade as application logout.
   - API responses should be handled safely when upstream/server responses are not JSON.
   - Every meaningful change should be verified before handoff.

---

## 3. Repository

**GitHub:** `ShalyX/inboxpay`

**Production branch:** `main`

The repo is intentionally framework-light:
- `public/` = static frontend
- `api/` = native Vercel Node functions
- `lib/` = server-side business/integration helpers
- root `.mjs` scripts = local/dev/proof utilities
- `contracts/` = Solidity contract sources

Current production entrypoint is the Vercel project:
**`tameion-ap-agent-live`**

Production URL:
**https://tameion-ap-agent-live.vercel.app/**

---

## 4. Live infrastructure

### Supabase

Project:
- Name: `InboxPay`
- Ref: `ecportgmionyhlofyobc`
- Region: `eu-west-1`
- Status at last inspection: `ACTIVE_HEALTHY`
- URL: `https://ecportgmionyhlofyobc.supabase.co`

Frontend uses the Supabase **publishable key** only.

Never commit:
- service-role keys
- secrets
- OAuth client secrets
- refresh tokens
- access tokens

### Vercel

Project:
- Name: `tameion-ap-agent-live`
- Project ID: `prj_St56WanvPiz0wnfb0gFHYZCQDsos`
- Team: `team_4d8N0eOfK7eCY4RPWlV4cuSN`
- GitHub repo: `ShalyX/inboxpay`
- Branch: `main`

The production alias is:
`tameion-ap-agent-live.vercel.app`

Verified production deployment carrying the per-business Arc environment selector, network-isolated wallets/policy vaults/vendors/invoices/audit data, settlement UI, payment preflight, activity surfaces, business profile control, durable invoice scheduling queue, and production frontend rebuild:
- Deployment: `dpl_H9Aa9W4EE5wNUqyTTsY1ELFv7eQf` / `https://tameion-ap-agent-live-3qmoold77-shalyxs-projects.vercel.app`
- Commit: `5a075f6ddb310c8476b01ca5f008fa92238e63bd`
- Message: `feat: rebuild InboxPay payment operations UI`
- State: `READY`

That deployment includes the auth/onboarding fixes, Circle SDK import repairs, dedicated-wallet retry protection, correct Supabase wallet persistence, financial-route/PDF runtime decoupling, Gmail PDF parsing hardening, real Arc Testnet wallet funding, and failed policy-deployment recovery described below.

### Per-business, per-network account migration (2026-10-12)

- Production Supabase now has `business_network_accounts`, one isolated account per `(business_id, network)` for `ARC-TESTNET` and `ARC`. It owns each environment's Circle wallet identity, provisioning state, policy-vault identity, deployment state, and errors.
- `businesses.active_network` is the selected environment. Policies, vendors, invoices, and audit events now carry an explicit network key; their uniqueness and query indexes include that network.
- The transactional migration in `supabase/migrations/20261012_business_network_accounts.sql` was applied successfully before the application deployment. It includes insert triggers so the previously deployed application remains compatible during the rollout.
- Both existing financial accounts were backfilled exactly. Verification returned two businesses, two network-account rows, RLS enabled, zero missing network values, `exact_financial_backfill=true`, and the unchanged legacy digest `514746929ab1b961e034c5161b849f57` before and after migration.
- Commit `9806e6d` is deployed `READY` as `dpl_9Do2pUGCkxKJiDBu5sBC8ar9uNUr`; the verified production alias deployment carrying the same feature code is `dpl_CkLqgwV449vqF6PP55NhthiijFda`. The public bundle contains the accessible Arc Testnet/Mainnet selector and loaded with no browser warnings/errors.
- Authenticated production switching was completed on 2026-10-12 for Caraxes Labs: Arc Testnet → Arc Mainnet → Arc Testnet. Mainnet rendered an isolated, unprovisioned account (`No wallet in Arc Mainnet`), zero settled invoices, and payment actions blocked; no wallet, vault, allowance, vendor mapping, policy mutation, or payment transaction was created. Returning to Testnet restored the original dedicated wallet `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`, policy vault `0x59ceead805ef96fc2839388cafe937150412383a`, four invoices, and the existing reconciled settlement unchanged.

---

## 5. Google authentication state

There are **two different Google OAuth jobs**. Do not merge them conceptually.

### A. InboxPay account authentication

Frontend:
`public/inboxpay.js`

Uses:
`supabase.auth.signInWithOAuth({ provider: "google", ... })`

Production redirect:
`https://tameion-ap-agent-live.vercel.app/`

Supabase hosted Auth callback:
`https://ecportgmionyhlofyobc.supabase.co/auth/v1/callback`

Google Cloud client type required:
**Web application**, not Desktop.

Production Google auth configuration was manually enabled/configured in Supabase using a Web OAuth client.

### B. Gmail connection

Custom routes:
- `api/gmail/start.mjs`
- `api/gmail/callback.mjs`

Callback:
`https://tameion-ap-agent-live.vercel.app/api/gmail/callback`

The Gmail connector stores encrypted Google Gmail access/refresh tokens in `integrations` and binds the integration to the authenticated InboxPay user and business.

Gmail uses read-only scopes in the current flow.

---

## 6. Authentication bug history and current fixes

### Historical issue: auth buttons did nothing
Cause: frontend initialization/event-listener code had previously been cut off.

Fixed in:
`7e638a0bd3284b23a2bd64e112076c1860e053bd`
Message:
`Restore frontend initialization and repair auth flows`

### Historical issue: email confirmation returned to localhost
Fixed by explicitly passing:
`emailRedirectTo: window.location.origin + "/"`

Commit:
`d653fd473fa6dfe89309869c7a82e3b37a2c59a3`
Message:
`Fix production email confirmation redirect`

### Historical issue: Google provider disabled
The original error was:
`Unsupported provider: provider is not enabled`

This was a Supabase configuration issue, not a frontend issue. It was corrected by enabling Google with a Web OAuth client.

### Historical issue: Google login immediately appeared to log out
Actual failure:
`Supabase 409: duplicate key value violates unique constraint "businesses_owner_user_id_key"`

Root cause:
the frontend could call `bootstrap()` concurrently from both the Supabase `SIGNED_IN` event and the initial `getSession()` path.

Fixes:
- client-side bootstrap promise de-duplication
- server-side idempotent business creation
- server-side idempotent policy creation

Commits:
`8914af3914bac98bba57bbc1eebb4a7262ad6007`
`Make business onboarding idempotent`

`b7d343b9e1e8ff16de9d673e37fcc168df18386e`
`Prevent concurrent auth bootstrap races`

There were **no duplicate business rows** when checked.

### Historical issue: “Unexpected token 'A'...”
Cause:
frontend assumed every endpoint returned JSON; a Vercel/plain-text server error caused the JSON parser itself to fail.

Fixes:
`f3f52fc8f0f957b2de5c9e669846aea0ff45891f`
`Handle non-JSON API errors without masking auth state`

`b67cc99405217f901ed42505fd8555018a25a015`
`Normalize API error text correctly`

Current frontend has `readJsonResponse(response)` and does not force a valid session back to the auth gate merely because bootstrap failed.

---

## 7. RESOLVED — Circle SDK and wallet provisioning blockers

The production wallet-provisioning route previously failed while importing the Circle SDK.

At the latest production runtime inspection, `/api/onboarding` produced:

`SyntaxError: Named export 'initiateDeveloperControlledWalletsClient' not found. The requested module '@circle-fin/developer-controlled-wallets' is a CommonJS module...`

Affected file:
`lib/circle-wallets.mjs`

The incompatible import was:

`import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";`

SDK `10.8.1` exposes a named ESM export locally, but Vercel's function runtime treated the dependency as CommonJS. A direct default ESM import was also tested and rejected by Node 24 because the package's ESM build has no default export.

The original import incompatibility was resolved in:
`105f446279530350102e916cac8161fe0ffe8e9a`

The helper now uses Node's `createRequire(import.meta.url)` and destructures `initiateDeveloperControlledWalletsClient` from the package's CommonJS export. Verification completed against:
- the installed `@circle-fin/developer-controlled-wallets@10.8.1`
- direct Node 24 import of `lib/circle-wallets.mjs`
- Vercel's generated Node 24 `api/onboarding` function bundle
- production deployment state `READY`

The default Arc Testnet path also required two missing production environment variables. `CIRCLE_TEST_API_KEY` and `CIRCLE_TEST_ENTITY_SECRET` are now configured as sensitive Vercel production variables using a verified Circle test account. Live credentials remain separate under the existing live credential names.

Authenticated production provisioning exposed and resolved three additional blockers:

- Circle resource names exceeded the provider's 50-character limit for realistic business names.
- The onboarding route spread camelCase wallet results into snake_case Supabase columns.
- The smart-contract SDK used the same ESM/CommonJS pattern and financial routes pulled in the Gmail PDF runtime transitively.

Resolved in:

- `238e516` — bounded Circle resource names, deterministic HMAC-derived idempotency keys, and business/network-scoped retry safety.
- `3553549` — explicit `wallet_set_id`, `wallet_id`, `wallet_address`, and `wallet_blockchain` persistence.
- `b890a2c` — CommonJS interop plus test/live credential and blockchain propagation for policy operations.
- `d29c363` — lightweight business lookup for financial routes so wallet/policy reads do not load PDF/Gmail dependencies.
- `5214a96` — dynamic production PDF parser loading, native canvas runtime dependency, and Google local-auth dependency upgrade.

Production verification completed for the authenticated `gmail.com` business:

- A dedicated Arc Testnet Circle wallet was created and persisted.
- A full page reload restored the same wallet from the correct business row.
- The live UI reports `ARC-TESTNET · Circle wallet · 0xca32c8…18d5e2 · 39.96 USDC` after a real Circle Arc Testnet faucet request and the policy-vault deployment fee.
- Deterministic duplicate helper calls returned the same wallet set, wallet ID, and address instead of creating additional resources.
- The production `/api/wallet` and `/api/policy` routes load without the previous SDK/PDF runtime crashes.
- A PaymentPolicyVault was deployed for this business on Arc Testnet and reconciled through Circle's contract/transaction status APIs.
- The first provider attempt failed with `TX_NOT_INITIATED`; the status route now surfaces failed provider state and the retry uses a fresh deterministic attempt key. The retry completed successfully.

Do not replace this business wallet with the executor/deployer wallet in `deployment.json`.

---

## 8. Circle / Arc state

### Authenticated business policy-vault state

The production `gmail.com` business currently has:
- policy contract status: `ready`
- policy contract address: `0x59ceead805ef96fc2839388cafe937150412383a`
- Circle contract ID: `01a110c7-f83d-7b03-84a9-a173f6d76c67`
- Circle transaction ID: `c9bf280a-e5ee-5523-ad56-8edfb57a9511`
- blockchain: `ARC-TESTNET`

This is a dedicated business policy vault. It is not the executor/deployer wallet or a shared treasury. Mainnet policy deployment remains explicitly gated.

### Business B Mainnet wallet

A separate authenticated Business B account now has its own Circle wallet on Arc Mainnet:
- blockchain: `ARC`
- wallet address: `0xa5639e…f4f80b`
- balance at creation: `0 USDC`; the wallet was later funded to `0.15 USDC`, then spent `0.0248842075 USDC` on the successful policy-vault deployment
- policy vault: the first Circle record `01a11292-867f-71f5-b129-80bba31e335d` failed with `TX_NOT_INITIATED`, but the later funded retry succeeded at `0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942`
- Mainnet wallet creation was explicitly confirmed; no Mainnet funds or payments have been moved.
- Refresh/reconnect restored the same Business B account, wallet, and Gmail connection after provisioning.
- Vercel Production has `INBOXPAY_ALLOW_MAINNET_WRITES=true` configured. The first funded deployment record failed before broadcast, a second attempt exposed the provider's aggregate fee requirement, and the final funded retry deployed successfully as documented below.

### Business B Mainnet deployment diagnosis (2026-10-06)

- A fresh authenticated status read still reports wallet balance `0.05 USDC` and policy record `01a11292-867f-71f5-b129-80bba31e335d` as Circle `FAILED` / `TX_NOT_INITIATED`; `policy_contract_address`, `policy_contract_tx_id`, and the provider transaction object are all null. No allowance or payment write was attempted.
- A subsequent explicitly confirmed retry reached Circle with contract record `01a11339-ee2b-79c5-beed-c39810dd256b` and transaction ID `edf55ef3-2f22-53b9-a067-924fb5b2bd31`, but Circle rejected it before broadcast with `INSUFFICIENT_NATIVE_TOKEN`: total pending fee `0.0654236295`, usable wallet balance `0.05`. No transaction hash or contract address was created and no funds were spent.
- InboxPay's Mainnet gate is working: the request passed only after `INBOXPAY_ALLOW_MAINNET_WRITES=true` was loaded in the fresh Production build, then the real `client.deployContract({ blockchain: "ARC", walletId: ... })` path returned `202` and Circle created the provider record.
- This is therefore not the earlier insufficient-USDC failure and not a Supabase/UI state issue. The failure occurs before Circle initiates an onchain transaction.
- The current Circle Smart Contract Platform skill explicitly lists Arc Mainnet (`ARC`) as supported, so “Arc Mainnet is unsupported” is not a confirmed root cause. Arc Studio is not a production workaround: it currently deploys to Arc Testnet and explicitly does not submit Mainnet transactions.
- A read-only Arc Mainnet RPC check against the exact 5,586-byte InboxPay deployment payload returned `eth_estimateGas = 1,167,758` at approximately `20 gwei`, or about `0.02336 USDC`; the wallet holds `0.05 USDC`. The raw chain estimate therefore shows sufficient gas headroom for this deployment.
- The deployed artifact is compiled with `solc 0.8.19` and `evmVersion: "paris"`, matching Circle's current Arc guidance and ruling out the documented `PUSH0`/Shanghai-bytecode incompatibility.
- The latest provider response resolves the immediate blocker: the wallet's `0.05 USDC` balance is below Circle's aggregate pending-fee requirement of `0.0654236295 USDC`. The earlier `TX_NOT_INITIATED` record was an opaque provider failure; this retry exposed the actionable cause.
- Do not retry until the same dedicated Business B wallet has a sufficient balance. The minimum shortfall is `0.0154236295 USDC`; a larger operational buffer is prudent because fee quotes can change. No shared executor wallet is permitted.

### Business B funding verification (2026-10-06)

- A read-only Arc Mainnet RPC balance check against the exact dedicated Business B wallet `0xa5639edc94b68af952f6744a8cd6a8b25ef4f80b` returned `0.15` native USDC (`eth_getBalance`, `0x214e8348c4f0000`). This is above the last Circle aggregate pending-fee requirement of `0.0654236295 USDC`.
- This verifies the external funding onchain, but it does not by itself mutate InboxPay state. The next write must be one authenticated production `POST /api/policy` deployment retry with `confirmMainnet: true`, followed by Circle contract/transaction polling. No allowance or payment write is authorized by this funding event.

### Business B Mainnet deployment (2026-10-07)

- The user started the authenticated production policy deployment after funding. Arc Mainnet now shows a successful contract-creation transaction from the dedicated Business B wallet: `0x4522a912f73e02e42cc3cb0e0f524207ad07365c1b5b40672fd75bb28e770154` (block `24,641,418`, receipt status `0x1`).
- Deployed policy vault: `0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942`. Read-only RPC bytecode verification returns `4,676` bytes at that address.
- The deployment transaction constructor data binds the vault to Business B wallet `0xa5639edc94b68af952f6744a8cd6a8b25ef4f80b`, Arc USDC `0x3600000000000000000000000000000000000000`, per-payment limit `1,000 USDC`, daily limit `5,000 USDC`, and cash floor `20 USDC`. Gas used was `1,157,405` at `21.5 gwei` (`0.0248842075 USDC`).
- This proves the onchain deployment succeeded. The next verification is an authenticated production status refresh to reconcile Circle's contract/transaction records into `policy_contract_status=ready`. USDC allowance and payment remain unapproved/unattempted.

### Business B Mainnet settlement-proof readiness (updated 2026-10-09)

- Read-only Arc Mainnet RPC verification confirms chain `5042`, active replacement vault `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706`, and dedicated wallet `0xa5639edc94b68af952f6744a8cd6a8b25ef4f80b`.
- The wallet currently holds `0.092142 USDC` (native Arc gas balance and the configured USDC balance read agree). The active policy cash floor is `20 USDC`, so no invoice can pass `canExecute` until the same business wallet is funded above `cash floor + invoice amount` and fees.
- The active vault allowance is `0`, the daily spend is `0`, and no production Business B invoice or real vendor is currently available for settlement. No policy, allowance, vendor, or payment write was submitted during this readiness check.
- The 2026-10-09 read-only production check found one Mainnet-business invoice: `TA-GMAIL-0001`, `0.500000 USDC`, vendor `Acme Test Hosting`, with a `gmail-live` extraction source but `ESCALATE` decision because the vendor is not verified. The DB vendor is intentionally `blocked`, and the active vault's `vendorRecipient` is the zero address. Do not unblock or pay this QA vendor to force the milestone; it is not an acceptable Mainnet proof invoice.
- The same check confirms the wallet currently holds `0.092142 USDC`, the active vault allowance is `0`, the cash floor is `20 USDC`, daily spend is `0`, and `canExecute` rejects this invoice with `VENDOR_NOT_ALLOWED`. No financial write was performed.
- The final settle confirmation UI has been hardened to display the exact network, invoice number, six-decimal amount, vendor, recipient, dedicated business wallet, and active policy vault before asking the user to continue. The API and contract still perform their own live checks; this confirmation is not a substitute for preflight.
- The next proof requires a genuine payable invoice from the business's real Gmail, an explicitly verified vendor recipient that can receive USDC on Arc, sufficient funding above `cashFloor + invoice amount` plus transaction-fee headroom, explicit USDC authorization, a live eligible preflight, and the exact final confirmation.

### Product control-gap correction (2026-10-07)

The Business B deployment exposed a real product flaw: InboxPay created draft defaults during onboarding, but the setup UI let the user deploy them without first reviewing or configuring the business's own limits. A production control-surface pass is now implemented in source and production-verified:

- Policy setup now requires the business to review maximum single payment, daily limit, and cash floor before its vault is deployed.
- An existing vault loads the authoritative onchain limits, exposes policy updates and emergency pause/resume, and requires an exact confirmation before any Arc Mainnet write.
- Verified-vendor enforcement and duplicate protection are shown as locked contract safeguards; the API rejects attempts to disable verified-vendor enforcement.
- USDC allowance is now an explicit business control with authorize and revoke actions. The UI discloses that authorization is an unlimited ERC-20 allowance while the vault contract continues to enforce bounded payment rules.
- Vendor reads compare the database record to the deployed vault mapping. A database-verified vendor missing from the vault is shown as `not onchain` and cannot make an invoice payment-ready.
- Vendor registration and payment submission now require explicit Mainnet confirmations in both UI and API. Payment confirmation shows the invoice, vendor, amount, network, and recipient.
- Invoice payment readiness now includes vault-ready, allowance, pause, and onchain vendor-registration gates. All agent decision reasons are visible instead of only the first reason.
- External Gmail/vendor strings are HTML-escaped before rendering, closing an authenticated stored/content-injection path.
- Full wallet, vault, and vendor addresses are visible and copyable.
- The policy control is available from the top bar as well as the sidebar, so it remains reachable when the responsive layout hides the sidebar.

Production verification completed on commit `5d37bea` / Vercel deployment `dpl_GYAbGmwiNELeYBJdkJqu95gECaED`:

- Git-triggered Vercel Production deployment reached `READY` and the production alias points to it.
- The authenticated Business B policy modal reads the live Arc Mainnet vault `0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942` and shows `1,000 USDC` maximum single payment, `5,000 USDC` daily limit, `20 USDC` cash floor, and `ENFORCED ONCHAIN`.
- The same live screen reports `USDC access not authorized`; no Mainnet allowance, vendor registration, policy update, or payment write was submitted during verification.
- Opening the policy screen generated authenticated `GET /api/policy` reads only. The only runtime stderr was Node's existing `DEP0169 url.parse()` deprecation warning.
- Rendered QA passed at the default narrow app viewport and at `1440×900`: the policy entry remains reachable, the modal is scrollable on narrow screens, and all policy/allowance controls are visible on desktop.

### Durable settlement recovery deployment (2026-10-07)

- Commit `66e12be` (`Harden settlement recovery and reconciliation`) was pushed to `main` and deployed Ready as Vercel deployment `dpl_9T98AuTzVtsoBe9zQyrsf6sV9gHB`. The terminal-`STUCK` recovery fix landed in commit `fc81e98` and is Ready as `dpl_4Laj6q2MDKwJuHjE6ppmAKqYz9t8`; handoff-only follow-ups also built Ready, and the production alias serves the same recovery code.
- The deployed financial routes include durable Circle submission tracking, deterministic payment idempotency keys, non-terminal `processing` state, refresh-time pending reconciliation, and Arc receipt/event validation before `confirmed`.
- Authenticated production read verification after deployment returned HTTP 200 from `/api/invoices` with `liveGmail=true`, Gmail status `connected`, Business B's dedicated Mainnet wallet/vault, and zero current invoice rows. No payment or allowance/vendor/policy write was submitted.
- The live policy control reads the replacement Mainnet vault `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706` with `1000 / 5000 / 20 USDC` limits and reports USDC access as not authorized. The old vault remains deployed but is no longer the active InboxPay policy vault.
- Static module checks and `npm run evaluate` passed locally. This verifies deployment integrity and the no-write live path. Adversarial recovery fixtures and the revocation contract test now pass locally as recorded below; a real settlement remains separately gated and untested on Business B Mainnet.

### Payment-readiness and activity surfaces (2026-10-07)

The next production build flow is now shipped and verified on commit `5fe89e8` / Vercel deployment `dpl_7hNtL7rkHDDVUhhR5ddWjrrLCh2U` (`READY`, production alias live):

- `GET /api/preflight?invoice=...` performs a read-only, business-scoped live check before payment authorization. It reads the active policy vault, vendor mapping, USDC allowance, wallet balance, daily spend, policy limits, pause state, settlement state, and the vault's `canExecute` reason. It fails closed when a live read is unavailable.
- The selected-invoice detail now separates the bounded agent decision reasons from payment-readiness reasons and displays each deterministic check. The settlement button stays disabled until the server preflight returns `eligible=true`; no payment write is performed by preflight.
- Payments and Audit trail now use a business-scoped read-only `GET /api/activity?view=payments|audit` endpoint. Payments exposes settlement status and Arc receipt links; Audit exposes the real policy, vendor, wallet, allowance, and settlement events.
- The first attempt exceeded the Vercel Hobby plan's 12-function deployment limit. The activity reads were consolidated into one route, leaving exactly 12 serverless functions; the subsequent production build reached `READY`.
- Authenticated browser verification after deployment showed Business B's dedicated Mainnet wallet and replacement vault, no invoice rows, no settlement attempts, and the real existing audit events. Browser console error/warning inspection was clean. The read-only unauthenticated route checks return `401` as expected.
- Mainnet state is unchanged and clean: the replacement vault remains `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706`, the Acme QA mapping remains blocked/zero onchain, the Business B USDC allowance remains `0`, and no Mainnet payment has been submitted.

### Business profile control (2026-10-07)

- Business identity editing is now available through the existing `/api/onboarding` function using the business-owner scoped `rename_business` action. Names are trimmed, whitespace-normalized, capped at 80 characters, and reject control characters.
- The UI clearly states that renaming does not change wallet ownership, policy limits, vendor permissions, or payment authorization. The mutation records a `business_profile_updated` audit event.
- Local `npm run test:profile` passes with invalid-length, control-character, whitespace, and Unicode cases. Production deployment `dpl_DctJx1xVFySU6k2EPhaNx3myLUAi` reached `READY`; the authenticated profile editor was verified without saving a change.
- Real vendor onboarding is intentionally deferred. Acme remains QA-only/blocked, the Mainnet allowance remains zero, and no payment write has been submitted.

### Durable invoice scheduling queue (2026-10-07)

- Commits `cbe91a0`, `965c33e`, and `808feb6` add a durable, review-only queue for invoices whose bounded agent decision is `SCHEDULE`, including clean malformed-date validation and explicit rescheduling. `PATCH /api/invoices` records an `invoice_scheduled` audit event and atomically moves the business-owned invoice to `settlement_status=scheduled`; no Circle, vendor, allowance, policy, or payment write is performed.
- The queue target defaults to 09:00 UTC on the invoice due date and is bounded to the next 366 days. A caller may supply a future ISO target within that bound. The schedule reason explicitly states that vendor verification and live policy preflight remain required.
- A queued invoice can be rescheduled with a new bounded ISO target. Rescheduling appends `invoice_schedule_rescheduled` with the previous and new target while preserving the queued state; the UI requires an explicit confirmation and states that no payment is submitted.
- `cancel_schedule` uses a compare-and-set update so a schedule can be cancelled without clearing a concurrent settlement state. The UI requires an explicit confirmation for queue and cancel actions, shows the review target, and states that no funds move. `/api/pay` preflight now fails closed for `scheduled` invoices until the schedule is cancelled.
- Schedule state is reconstructed from the business-scoped audit trail during invoice refresh. No real vendor onboarding was performed for this slice; Business B's Mainnet wallet, replacement vault, zero allowance, blocked Acme QA mapping, and zero Mainnet payment state are unchanged.
- The refresh query includes `invoice_schedule_rescheduled` alongside schedule and cancellation events. Commit `11cb676` adds a regression test against the generated audit-event query path; a reschedule now survives refresh with its new target instead of falling back to the original schedule.
- Local verification passes: `npm run test:scheduling`, `npm run test:local`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:migration`, `npm run test:profile`, `forge test`, JavaScript syntax checks, and `git diff --check`.

### Local runtime and due-review plumbing (2026-10-07)

- Commit `a85074b` repairs `npm start`: the local server now dispatches to the same production-shaped API handlers, with bounded JSON parsing, path-traversal protection, HEAD behavior, and no mock invoice/payment layer. `server.local.mjs` delegates to the same entrypoint.
- `POST /api/invoices` with `{action:"review_due"}` is an authenticated, owner-scoped due-review trigger. It scans persisted business invoices, compare-and-set transitions due scheduled rows to `settlement_status=review`, and records `invoice_schedule_due`; it never calls Circle, authorizes payment, or submits a transaction.
- Due-review UI shows `Due for review` and requires an explicit `Release to review` action before the invoice can re-enter normal live preflight. No production invoice/vendor state was mutated during verification because Business B currently has zero invoice rows.
- Local verification passes: `npm run test:local`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:migration`, `npm run test:profile`, `forge test`, JavaScript syntax checks, and `git diff --check`.

Known gaps from this audit remain queued and must not be papered over:

- **P0 contract migration:** new source and artifact support `setVendor(address(0))` for revocation and expose `vendorRevocationSupported()`. `forge test` passes the revocation behavior test. The generated optimized Paris artifact uses solc 0.8.24 (4,563-byte creation bytecode, excluding the `0x` prefix). The original Business B vault at `0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942` remains deployed but is now legacy. The user-confirmed migration completed: InboxPay now points to replacement vault `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706`; a direct Arc Mainnet RPC read returns `vendorRevocationSupported() = true`, 3,841 bytes of code, and `1,000,000,000 / 5,000,000,000 / 20,000,000` six-decimal USDC limits. Authenticated UI verification shows the replacement vault and `USDC access not authorized`; the vendor registry is empty after cutover. Allowance, vendor registration, and payment remain separate explicit actions.
- **P0 reconciliation recovery:** the source implementation records Circle submission IDs and deterministic idempotency keys before waiting, keeps provider timeouts in `processing`, reconciles pending invoices on authenticated refresh, distinguishes terminal provider failure (including Circle `STUCK`) from unknown/confirming state, and validates the Arc receipt against the expected policy vault, payment ID, vendor, recipient, amount, and invoice hash. `npm run test:recovery` now passes adversarial fixtures for idempotency, bounded retries, Circle terminal states, event matching, missing/reverted receipts, and wrong vault/event data. This is source-level verification; do not call the settlement loop fully production-verified until the latest code is deployed and live recovery behavior is checked. A real settlement remains untested on Business B Mainnet.
- **P1 product surfaces:** complete for the current slice. Payments and Audit trail are business-scoped read-only views with settlement status, receipt links, and audit event detail. Continue expanding receipt/recovery UX as real settlements accumulate.
- **P1 policy preflight:** complete for the current slice. Daily spend, wallet balance/cash-floor headroom, allowance, limits, vendor mapping, settlement state, and the live `canExecute` reason are surfaced per invoice before submission. Continue adversarial testing with a real invoice when a real vendor is available.
- **P1 onboarding:** business name editing is complete. New accounts still receive an inferred initial name, but the owner can now correct it from the authenticated product UI.
- **P1 scheduling:** due-review transition plumbing and owner-authenticated triggering are complete, including persisted reschedule reconstruction. `SCHEDULE` currently means “queue for future review,” not “pay automatically at this time.” A true background worker/cron, service authentication, retry/lease semantics, execution-authority design, and automatic payment remain later slices; a queued or due invoice never authorizes payment by itself.
- **Developer workflow:** the local runtime is repaired and `npm run test:local` passes. Local authenticated API use still requires the configured environment and an authenticated session.

### Mainnet PaymentPolicyVault

Production vault:
`0xa1dafca93784eeeecd081662435a5943eba73c66`

Deployment tx:
`0x17c9a773e2544a349f030b71dfdceb60eb5460a63b503fa7fb0086b8a1c34341`

Arc chain ID:
`5042`

Arc USDC:
`0x3600000000000000000000000000000000000000`

The root `deployment.json` records the deployed policy configuration.

### Existing executor/deployer wallet

`deployment.json` currently records:
- executor wallet ID: `dde269af-d92d-5f96-be60-69ebfcc19df7`
- executor address: `0xd3bb84b06dfdbeb0b4bf079dc9daaf7a68e55c7c`

This is **not permission to use this as a global customer treasury wallet**.

Business wallets must be provisioned separately per business.

### Real x402 proof

A real 0.001 USDC x402 purchase was completed on Arc Mainnet.

Transaction:
`0x0957a0febac2b4d5757148aa8e9d36861167ef4139c20bfd5105a4b404ac0186`

This is proof infrastructure, not a substitute for the product's real AP settlement flow.

---

## 9. Supabase schema snapshot

At the last schema inspection, the relevant public tables were:

### `businesses`
Key fields:
- `id`
- `owner_user_id` UNIQUE
- `name`
- `slug` UNIQUE
- `wallet_set_id` UNIQUE nullable
- `wallet_id` UNIQUE nullable
- `wallet_address` UNIQUE nullable
- `wallet_blockchain`
- `wallet_status`
- `wallet_error`
- `policy_contract_id` UNIQUE nullable
- `policy_contract_address` UNIQUE nullable
- `policy_contract_status`
- `policy_contract_tx_id`
- `policy_contract_blockchain`
- `policy_contract_error`
- `policy_contract_configured_at`
- `policy_contract_sync_error`

### `policies`
- unique `user_id`
- `business_id`
- `max_transaction_usdc`
- `daily_limit_usdc`
- `cash_floor_usdc`
- `require_verified_vendor`
- `paused`

### `integrations`
- `user_id`
- `business_id`
- `provider` = `google_gmail`
- `provider_account_id`
- encrypted access/refresh token fields
- `token_expires_at`
- `scopes`
- `status`

### `invoices`
Contains:
- business/user/integration linkage
- Gmail message/thread IDs
- vendor/invoice number
- amount/currency/due date
- agent decision + reasons
- extraction + sources
- payment ID
- settlement status
- payment tx hash
- raw fingerprint

### `vendors`
Per-business settlement registry:
- `business_id`
- `name`
- `recipient_address`
- `currency`
- `status`

### `audit_events`
Records user/system settlement/policy activity.

All inspected public tables had RLS enabled.

---

## 10. Important backend routes

Main production routes include:

### Authentication / onboarding
- `/api/config`
- `/api/session`
- `/api/onboarding`

### Gmail
- `/api/gmail/start`
- `/api/gmail/callback`

### Business execution
- `/api/wallet`
- `/api/policy`
- `/api/vendors`
- `/api/invoices`
- `/api/pay`

Before changing a route, inspect the associated `lib/` helper chain. Do not duplicate Circle/Supabase logic inside handlers when a shared helper exists.

---

## 11. Frontend state / behavior

Primary frontend:
`public/index.html`
`public/inboxpay.js`
`public/styles.css`

The app has two major states:

### Auth gate
- email/password sign in
- email/password business-account creation
- Continue with Google
- production redirect handling

### Authenticated app
- business identity
- dedicated wallet status/balance
- Add vendor
- Connect Gmail
- Refresh inbox
- invoice queue
- invoice detail / agent reasoning
- policy checks
- Arc settlement action
- settlement/reconciliation state

Important:
`bootstrap()` is intentionally idempotent on the client.

Do not reintroduce multiple independent bootstrap paths.

---

## 12. Business onboarding flow

Current intended flow:

1. Authenticate business user.
2. `/api/onboarding` creates/loads exactly one business for `auth.uid()`.
3. Policy row is created/loaded idempotently.
4. User explicitly provisions their dedicated Circle wallet.
5. User connects the real business Gmail account.
6. User adds/verifies settlement addresses for vendors.
7. User deploys the onchain policy vault.
8. User funds the appropriate vault/wallet state.
9. InboxPay scans the real inbox.
10. Invoice evaluator produces a bounded decision.
11. Only `PAY_NOW` + all deterministic gates can reach `/api/pay`.
12. Payment is executed using the business's dedicated Circle wallet.
13. Arc confirmation is reconciled and shown in the UI.

Wallet creation is deliberately **not automatic on login**.

---

## 13. Settlement gates

A payment must not execute merely because an LLM says `PAY_NOW`.

Current intended gates include:

- invoice has required fields
- invoice currency is USDC
- vendor is verified/allowlisted
- business wallet is ready
- business policy exists
- policy vault is ready
- business is not paused
- per-transaction limit passes
- daily spending limit passes
- cash-floor rule passes
- duplicate payment ID is not already executed
- destination matches the vendor registry
- policy vault has sufficient usable balance

The smart contract should remain the final enforcement boundary for contract-level constraints.

---

## 14. Local/dev scripts still in repo

There are local utilities such as:
- `gmail-bridge.mjs`
- `gmail-invoice-search.mjs`
- `gmail-send-test-invoice.mjs`
- `gmail-subject-search.mjs`
- `inspect-invoice-email.mjs`
- `first-live-invoice.mjs`
- `pay-gmail-invoice.mjs`
- `agent-evaluator.mjs`

Useful npm scripts:
- `npm start`
- `npm run scan:gmail`
- `npm run evaluate`

Some of these utilities represent the earlier/local investigation flow. They must not silently become the production onboarding architecture.

---

## 15. Documentation state

The only Markdown files currently tracked on `main` are:

- `README.md`
- `GMAIL-SETUP.md`
- this file: `AGENTHANDOFF.md`

`README.md` now documents:
- Supabase auth
- Google Web OAuth
- production redirects
- Gmail OAuth separation
- dedicated business wallet onboarding

`GMAIL-SETUP.md` now documents the production Gmail OAuth flow rather than the old Desktop OAuth/local-credential onboarding.

Whenever architecture or production state changes, update this handoff and any affected docs in the same change set.

---

## 16. Current production verification status

At last inspection:
- Supabase project: healthy
- latest Vercel deployment: READY
- production frontend served HTTP 200
- no duplicate business rows were found
- historical auth duplicate-key issue was fixed
- historical JSON parser masking issue was fixed
- Circle SDK ESM/CommonJS import blocker is fixed and deployed
- Arc Testnet Circle credentials are configured under the server's expected production variable names
- Google login completed and remained authenticated as the existing `gmail.com` business
- authenticated Arc Testnet wallet creation and business-row persistence completed
- a separate Business B account was authenticated and its dedicated Arc Mainnet wallet was created and persisted; the active replacement Mainnet policy vault is deployed and ready, the wallet has been funded, the allowance is currently revoked (`0`), and no Business B Mainnet payment has been submitted
- refresh/reconnect after Mainnet wallet provisioning restored the same Business B wallet and Gmail state
- the confirmed Business B Mainnet policy deployment reached the real Circle provider after the runtime flag was loaded; with `0.05 USDC` funded, Circle created contract record `01a11292-867f-71f5-b129-80bba31e335d` and later returned `FAILED` / `TX_NOT_INITIATED`, with no onchain contract address or transaction ID
- deterministic retry behavior was verified against the real Circle test account
- the persisted wallet and live balance reload successfully in production (`39.96 USDC` after the testnet faucet and policy deployment fee)
- production Supabase and commit `9806e6d` now model Testnet/Mainnet as isolated account contexts for every business; the two legacy financial accounts were backfilled exactly, RLS is enabled, all scoped records have network keys, and the selector is present in the live bundle
- financial routes no longer crash through the PDF runtime
- Gmail OAuth callback configuration is saved and the real Gmail integration is connected in production.
- The connected Gmail integration is encrypted and refreshable; the live inbox currently yields 9 invoice records.
- The selected `TA-GMAIL-0001` invoice for `Acme Test Hosting` was settled from the dedicated business wallet on Arc Testnet after explicit authorization. The production API records `settlement_status=confirmed`, payment transaction `0x7dc26bc15519137fdf28b07f1d72bbf38dd001ac14f47be3daf3a3b77ca33090`, and `reconciled=true`; the `payment_settled` audit event records the same hash. The live UI shows `0.00 USDC` ready to pay, `0 approved invoices`, `1 settled`, and `Reconciliation PASS`. The wallet balance is `39.45334 USDC` after the 0.50 USDC payment and network fees.
- The policy-vault deployment path is live on Arc Testnet and currently ready.
- The intended live invoice vendor, `Acme Test Hosting`, is now registered and verified against the documented Arc/EVM recipient address.
- The durable `SCHEDULE` queue is deployed and read-only verified: it persists review state, cancellation, and rescheduling without authorizing payment. The Mainnet Business B account now has one invoice row (`TA-GMAIL-0001`), but it is a QA/test-hosting record in `ESCALATE` state with the vendor intentionally blocked; no scheduling or payment mutation was performed for it.
- The Mainnet settlement-proof readiness check found Business B's dedicated wallet at `0.092142 USDC`, active cash floor `20 USDC`, and vault allowance `0`; the proof remains blocked until the real invoice/vendor/funding/authorization gates are satisfied.

The `audit_events` RLS policy is now corrected in Supabase. Authenticated inserts require `user_id = auth.uid()` and ownership of the referenced business. A real authenticated `vendor_registered` audit insert returned HTTP 201. The earlier testnet-funding audit failure should be retested on the next real funding request; no server-authorized bypass was added.

Acme vendor verification is complete on Arc Testnet. Circle transaction `0x5c61812fe41284e1b79fde64c62936b10ddd61e1e1b33096c3c1a5e80948804a` completed, the onchain vault returns Acme's registered recipient, and the `vendor_policy_updated` audit event was written. The subsequent settlement transaction is `0x7dc26bc15519137fdf28b07f1d72bbf38dd001ac14f47be3daf3a3b77ca33090`; the authenticated invoice API and audit trail both confirm it reconciled successfully.

The dedicated wallet's USDC allowance to its policy vault has now been explicitly approved on Arc Testnet. Circle reports the approval transaction `COMPLETE`, the live allowance is the maximum uint256 value, and the wallet balance was approximately `39.95 USDC` before settlement. After the confirmed 0.50 USDC payment, the live wallet balance is `39.45334 USDC`.

Do not mark the product “fully working” until the following are verified live:

### Auth
- Google login completes and stays authenticated.
- Existing business loads without duplicate-key errors.
- Email/password login/signup still works.
- Production email confirmation returns to the production origin.

### Business setup
- Dedicated Arc Testnet wallet creation succeeds. **Verified.**
- Wallet details persist to the correct business row. **Verified.**
- A retry does not create another Circle wallet. **Verified at the Circle helper boundary.**
- Dedicated Arc Mainnet wallet creation is **verified for separate Business B** after explicit confirmation; the existing Testnet wallet was not replaced.
- Vercel Production `INBOXPAY_ALLOW_MAINNET_WRITES=true` is configured and verified. Business B's dedicated Mainnet replacement vault is active at `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706`; the original vault remains legacy. Acme Test Hosting was registered for QA and is now blocked with its onchain mapping cleared. The replacement vault's USDC allowance is now revoked. Payment remains a separate explicit action.

- Arc Testnet policy-vault deployment succeeds after real faucet funding. **Verified.**
- Failed provider contract state is surfaced as an actionable error and can be retried without parallel duplicate deployment. **Verified.**

### Gmail
- Connect Gmail completes. **Verified.**
- Integration is bound to the correct InboxPay user/business. **Verified.**
- Encrypted refresh/access tokens persist. **Verified.**
- Refresh inbox reads the connected account and currently returns 9 records. **Verified.**

### AP
- Real invoices appear in the queue. **Verified (9 records).**
- Extraction is evidence-based. **Verified on the live selected record.**
- Agent decision is bounded. **Verified.**
- Duplicate/vendor/currency/policy checks are visible. **Verified; Acme is now verified and the selected invoice evaluates to `PAY_NOW`. The live USD records evaluate to `HOLD` with the payment button disabled because the Arc rail requires USDC; no held invoice was submitted.**

### Refresh / adversarial rejection QA
- Refresh/reconnect after Business B Mainnet wallet provisioning restored the authenticated account, dedicated wallet, Gmail connection, and `0 USDC` balance. **Verified.**
- Mainnet policy deployment without `confirmMainnet=true` returns HTTP `409` and performs no provider write. **Verified.**
- Mainnet policy deployment without the flag is blocked before provider access; after a fresh build loaded `INBOXPAY_ALLOW_MAINNET_WRITES=true`, the authenticated funded request reached Circle and returned `202`, then Circle marked the contract record `FAILED` / `TX_NOT_INITIATED`. **Verified; no onchain address or transaction was created.**
- USDC approval before a policy vault exists returns HTTP `409` (`Onchain policy vault is not ready`). **Verified.**
- Invalid vendor address and non-USDC vendor currency return HTTP `400` before persistence. **Verified.**
- Invalid policy values (per-payment limit above daily limit and negative cash floor) return HTTP `400` before persistence. **Verified.**

### Settlement
- Approved invoice can settle from the correct business wallet. **Verified on Arc Testnet for `TA-GMAIL-0001`; the dedicated wallet paid 0.50 USDC and reconciliation passed.**
- Mainnet confirmation is explicit.
- Actual Arc Testnet transaction hash is stored: `0x7dc26bc15519137fdf28b07f1d72bbf38dd001ac14f47be3daf3a3b77ca33090`.
- Reconciliation reflects the real transaction state. **Verified (`settlement_status=confirmed`, `reconciled=true`).**
- Business A can never spend Business B's wallet.

---

## 17. Codex operating protocol

When taking over:

1. **Read this file completely.**
2. Inspect `README.md`, `GMAIL-SETUP.md`, `package.json`, `deployment.json`, and the relevant code before changing anything.
3. Check current `main` and current Vercel deployment rather than trusting an old deployment snapshot.
4. Check Supabase schema/state when touching auth, RLS, business ownership, integrations, invoices, policies, vendors, or audit events.
5. Reproduce the current blocker before fixing it.
6. Make the smallest production-correct change.
7. Run the strongest available verification.
8. Deploy through the existing Git → Vercel pipeline.
9. Inspect runtime/build logs after deployment.
10. Update `AGENTHANDOFF.md` when the state materially changes.

### Do not:
- ask the user to restate project context already documented here
- replace real integrations with mocks just to make the demo work
- add a global treasury wallet
- expose OAuth/client secrets
- persist raw Gmail tokens without encryption
- use user-editable metadata as an authorization source
- disable RLS as a shortcut
- swallow payment failures
- claim a transaction succeeded without onchain evidence
- introduce duplicate onboarding side effects
- revert to the old Desktop OAuth Gmail architecture

### Preferred debugging order
**reproduce → inspect logs → inspect exact file → patch minimally → deploy → verify → update handoff**

---

## 18. Immediate next actions

### P0 — Fix Circle wallet provisioning
Complete and deployed. The ESM/CommonJS import incompatibility, authenticated Arc Testnet provisioning, deterministic retry behavior, and correct business-row persistence are verified in production. Do not create a mainnet wallet or policy vault without explicit user confirmation.

### P0 — Re-run production Google auth
Completed after the wallet changes:
- production Google sign-in remained authenticated
- the existing business loaded without duplicate-key errors
- setup state and persisted wallet rendered without logging out
- current deployment produced no new HTTP 500 logs during verification

### P1 — Complete real Gmail connection
Complete and deployed. The production callback URI is saved, Gmail is connected, the integration is encrypted against the authenticated business, and inbox refresh returns 9 real records.

### P1 — Complete one real invoice end-to-end
Use a genuine test/business invoice email and continue only after explicit user action where required:
- verify/register the intended vendor
- re-evaluate the invoice and confirm deterministic policy gates
- obtain explicit confirmation before any USDC approval or payment transaction
- settle only from this business's dedicated wallet on the intended network
- reconcile the actual Arc transaction and receipt

Do not use held or unverified records as a reason to bypass the vendor gate. Business B's Mainnet vault is deployed, but USDC allowance, Mainnet vendor registration, and settlement remain separate explicit actions. Do not submit any of them merely because the vault exists.

Current handoff state: Acme Test Hosting has `status=verified` for the Testnet QA business, the policy-vault recipient mapping is confirmed on Arc Testnet, the selected invoice has settled as `confirmed`, the wallet allowance is approved, and reconciliation passed for the recorded Arc Testnet transaction. Business B's separate Arc Mainnet wallet is provisioned and its active replacement policy vault is `0xbfd7f80416bda5a2c2c79ad4f8ff108c6c3b0706`; the original `0x8d8e3e5b0ca5da40c4976cf8b7fb589f3d400942` remains legacy. The Mainnet Acme QA mapping is blocked and reads as the zero address onchain. The Business B Mainnet allowance is revoked and reads as zero onchain. No Business B Mainnet payment transaction has been submitted.

### P0 — Durable settlement recovery and revocation migration (migration verified; allowance/vendor/payment still gated)

The settlement path now persists a `payment_submitted` audit record immediately after Circle returns a transaction ID, uses a stable idempotency key per business/payment/attempt, keeps non-terminal Circle timeouts in `processing`, and exposes recovery through the normal invoice refresh path. Arc reconciliation checks the actual receipt, transaction target, `usedPayment` marker, and `PaymentExecuted` event fields before confirming. The UI exposes `PROCESSING`, `FAILED`, and `REVIEW` states without claiming settlement prematurely. No Mainnet payment was submitted while implementing or verifying this change.

Local checks: `npm run test:recovery` and `npm run test:migration` pass; `forge test` passes the zero-address vendor-revocation test; `npm run compile:policy` regenerates the optimized Paris artifact with solc 0.8.24. The migration UI/API shipped in `b930c3e434c66130f19b1199dd63e852fe6fd658` / `dpl_FeepTti4C4E7B3W9yW2xXugzzP6B`, and the user confirmed the Mainnet migration. The vendor revoke control shipped in `4029eceac2617c689d4523cb5c45ae332e7e4c5d` / `dpl_38GsRfWABB6JBpxVs21HuvMDJQwy`; authenticated production verification shows Acme blocked and direct RPC confirms its recipient mapping is zero. Authenticated UI and public RPC now confirm the replacement vault's USDC allowance is revoked (`0`). No Business B Mainnet payment has been submitted.

### P1 — Payment-readiness and activity surfaces (complete)

Commit `5fe89e8` and Vercel deployment `dpl_7hNtL7rkHDDVUhhR5ddWjrrLCh2U` are production-ready. Local `npm run test:preflight`, `npm run test:recovery`, `npm run test:migration`, `forge test`, JavaScript syntax checks, and `git diff --check` pass. The live authenticated read path verified the compact-layout Payments and Audit entry points, the clean Business B payment history, and the existing audit trail without any Mainnet write. Keep the payment button fail-closed until a real invoice, intended real vendor, allowance, and explicit payment confirmation are all present.

### P1 — Durable invoice scheduling queue (complete for review semantics)

Commits `cbe91a0`, `965c33e`, and `808feb6` are deployed in `READY` Vercel deployments `dpl_Ehb93FyNcjZk8nDeU2RqGVDQEhLr`, `dpl_BRRHbBTZCTtTgvaDwQudjMYQ1uoP`, and `dpl_5fiyqpDxK6rfURGhDdofGTDxdE64`. The latest handoff-only build `dpl_E3hzi76GG4QuLZf9qtLWeCcxkWH2` is also `READY`; authenticated production verification returned the Business B session, dedicated wallet, connected Gmail, zero invoices, and no browser warnings/errors. The queue is intentionally review-only: it persists `SCHEDULE` state, cancellation, and rescheduling, but it does not create a worker or authorize a payment. Keep real vendor onboarding and Business B Mainnet allowance/payment actions separately gated.

The follow-up query-path fix is commit `11cb676`, deployed `READY` as `dpl_B78wCnZX5Q71HtChehtWaj84Qk3T`. It includes `invoice_schedule_rescheduled` in persisted audit reads and verifies that refresh reconstruction uses the new target. This remains a review queue: no background wake-up or automatic payment execution is enabled.

### P1 — Local runtime and due-review plumbing (complete)

Commit `a85074b` repairs the local server and adds the authenticated `review_due` trigger plus due-review UI. The trigger is compare-and-set and audit-backed, and stops at human review; it does not call Circle or authorize payment. Feature deployment `dpl_7t9ecBPQ8mov559ZXLCtzFzam9Sr` reached `READY`; handoff-only documentation deployment `dpl_DVVrBQZ5yVz9GcaAMJziGDbrWtE3` also reached `READY`. `npm run test:local` and the full regression suite pass. Business B production verification remains read-only with zero invoice rows and no vendor or payment mutation. A real background worker, service authentication, and automatic execution remain intentionally deferred.

### P1 — Per-business Arc environment accounts (complete and production-verified)

Commit `9806e6d` and the verified production alias deployment `dpl_CkLqgwV449vqF6PP55NhthiijFda` introduce a safe Testnet/Mainnet selector backed by `business_network_accounts`. Every financial read and mutation is scoped to the active network, and mutation requests carry the UI's expected network so a stale tab fails closed with HTTP `409`. Mainnet selection and wallet creation remain explicitly confirmed; switching alone does not move funds. The full JavaScript regression suite, `forge test`, GitHub policy artifact build, production database preservation checks, Vercel build, public bundle selector check, and browser error check pass.

Authenticated production QA also passes: Caraxes Labs was switched Testnet → Mainnet → Testnet. The Mainnet view correctly exposed a separate unprovisioned account, no Mainnet settlement, and blocked payment readiness without leaking the Testnet wallet, vault, vendor verification, or settlement state. Returning to Testnet restored wallet `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`, vault `0x59ceead805ef96fc2839388cafe937150412383a`, the four-invoice queue, and the existing reconciled settlement unchanged. No wallet provisioning, policy write, allowance, vendor mutation, or payment was performed during the test.

### P1 — Production frontend rebuild (complete and production-verified)

The frontend has been rebuilt as a payment-operations ledger while preserving every existing API contract, DOM action ID, network confirmation, Gmail flow, policy control, vendor gate, payment preflight, and reconciliation path. The new system replaces the test-dashboard presentation with a high-trust operational shell: dark persistent navigation, explicit business/network/wallet context, grouped controls, unified operational metrics, a dense invoice queue, sticky evidence pane, redesigned policy/activity/vendor modals, a complete authentication experience, responsive layouts, keyboard focus states, reduced-motion support, and a matching favicon.

Design research used Seesaw's Fintech collection as general reference material, with Acctual informing payment clarity, Ramp informing decisive hierarchy, and Midday/Ambrook informing financial density and reconciliation language. InboxPay's structure and identity remain original rather than copied from those references.

Feature commit `5a075f6ddb310c8476b01ca5f008fa92238e63bd` is deployed `READY` as `dpl_H9Aa9W4EE5wNUqyTTsY1ELFv7eQf` at `https://tameion-ap-agent-live-3qmoold77-shalyxs-projects.vercel.app`, with the production alias serving the same build. Local verification passes: `git diff --check`, JavaScript syntax validation, all nine JavaScript regression suites, `npm run evaluate`, and `forge test`.

Authenticated production QA is complete. The Caraxes Labs Arc Mainnet view restored its real session, dedicated Circle wallet, live Gmail source, and two-invoice queue. The invoice evidence/readiness pane, policy editor, empty payment history, and populated audit trail all rendered correctly without performing a write. The exact 390px mobile viewport and the desktop layout were visually inspected, including the responsive policy modal. Browser logs contained no warnings or errors. No network switch, wallet provisioning, policy deployment, allowance, vendor mutation, or payment was performed during this frontend verification.

### P0 — Frontend state consistency and production deployment target (code fixed; production promotion pending)

Commit `fe8c03e` fixes four reliability defects found during a live frontend review:
- every network label now derives from the selected account's `active_network` (falling back to `wallet_blockchain`) instead of mixing selected Mainnet state with stale Testnet copy;
- the execution-readiness rail now reflects the actual selected invoice/preflight/settlement state and exposes the current step accessibly;
- Gmail failures no longer expose raw server configuration text in the browser, while revoked OAuth credentials still receive the explicit reconnect path;
- the 390px business/wallet context is stacked and long wallet addresses wrap instead of clipping horizontally.

The behavior is covered by `npm run test:frontend` in addition to the full JavaScript regression suite, JavaScript syntax validation, `git diff --check`, and `forge test`. Preview deployment `dpl_78ssFMudaenJcg4ysAtMMh7rQmzp` is `READY` at `https://tameion-ap-agent-live-q0g8x8n6e-shalyxs-projects.vercel.app`. Desktop and exact 390px preview QA pass and browser logs contain no warnings or errors.

The canonical production alias previously resolved to `dpl_Hq1dJG8zFdYUgyzD5mthTJADMY2d`, whose Vercel target was incorrectly `preview`. Preview has only `SUPABASE_PUBLISHABLE_KEY`; Gmail OAuth and `INBOXPAY_TOKEN_ENCRYPTION_KEY` are intentionally Production-only. Consequently the live Gmail route reported the server-side 32-byte encryption-key configuration failure even though `lib/secure-tokens.mjs` was correctly enforcing the key format. The user explicitly approved a fresh Production-target build. Deployment `dpl_DteuHYMTsWWoQK4C3GTw6nvWisFG` reached `READY`, and `https://tameion-ap-agent-live.vercel.app` now resolves to that Production deployment with the existing protected variables. Do not weaken encryption validation or copy the live token key into Preview.

Authenticated production reload proved that the encryption/configuration failure is gone and the saved Google refresh token is independently expired or revoked. The UI presents the intended reconnect path without exposing the provider/configuration string; all visible environment labels agree on Arc Testnet for the restored account, exact 390px mobile QA passes without clipping, and browser logs contain no warnings/errors. Runtime logs then exposed a monitoring-contract flaw: the recoverable Google revocation still returned HTTP `500`. The follow-up route contract now classifies revoked/`invalid_grant` Gmail credentials as `409 GMAIL_REAUTH_REQUIRED`, preserves InboxPay session failures as `401`, sanitizes unexpected `500` responses, and records reauthorization as a warning rather than an internal error. Commit `3c8d47a` is deployed `READY` as Production deployment `dpl_HhqcDos3GzCJfoA2XRd1RFrBePAQ`; the canonical alias points to it, and live runtime verification shows `/api/invoices` returning `409` with the safe reauthorization warning rather than `500`. `npm run test:invoice-route`, the full JavaScript regression suite, syntax checks, `git diff --check`, and `forge test` pass. Gmail reconnection remains a separate OAuth permission action; the current attempt reached Google's consent screen after an earlier expired/invalid state callback. No payment, allowance, vendor, policy, wallet, or network mutation was performed while deploying or verifying these fixes.

The earlier invalid Gmail callback was traced to two `/api/gmail/start` requests created five seconds apart: the second request replaced the short-lived encrypted state cookie before the first Google callback returned. Commit `c7df793` adds a tested single-flight reconnect guard, immediately disables every visible reconnect control, and displays `Opening Google…` until navigation or failure. Production deployment `dpl_9JWHrBGnjKqWe9B2jZiMJFz85EyT` is `READY` and owns the canonical alias. The full regression suite and `forge test` pass. The user completed one fresh read-only Gmail reconnect through the single-state flow. Production logs show the callback redirect and `/api/invoices` returning HTTP `200`; authenticated UI verification reports `liveGmail: yes`, four real invoices, one existing reconciled settlement, three review/held records, consistent Arc Testnet context, and a clean browser console. The selected `Manny` record remains fail-closed with `ESCALATE`, an unverified/unregistered vendor, `VENDOR_NOT_ALLOWED`, and a disabled payment button. No payment, allowance, vendor, policy, wallet, or network mutation was performed during this verification.

### P1 — Operations UI consistency pass (deployed and verified)

The user still considers the frontend below product-ready quality. This focused pass in `public/styles.css` raises small operational text and controls, gives invoice rows and evidence more room, moves the execution rail below a readable two-column workspace, removes the duplicate top shortcut strip while retaining sidebar navigation, and aligns the full-page settings surface with the current sidebar width. At 390px, an older rule had hidden invoice amounts entirely; the pass restores them and keeps the policy-vault address/status readable. Full-page settings now lock background scrolling. Do not describe this as a finished product-wide redesign.

Commit `64633c2` fast-forwarded the previously ahead `restructure/business-workspace` history into `main` and was pushed to `origin/main`. Git-triggered Production deployment `dpl_3YTBYVti7GNiivuUKBBhevmNmqgY` reached `READY`; the follow-up handoff-only commit `78dd392` produced Production deployment `dpl_4CwSsJjtVSMzGPfpk9rPYE1dGgQo`, which then owned `https://tameion-ap-agent-live.vercel.app`. Local `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, and `git diff --check` pass. Authenticated Production QA loaded the existing Caraxes Labs Arc Testnet account, connected live Gmail, four real invoice rows, the prior reconciled settlement, and the same dedicated wallet. At 390px the invoice amounts are visible, there is no horizontal overflow, and the selected payment remains disabled; browser warnings/errors are empty. Runtime requests returned successful or cached responses; Vercel logged only the existing Node `DEP0169` deprecation warning as stderr on policy/preflight reads. No payment, allowance, vendor, policy, wallet, or network mutation was made during this release verification.

### P1 — Workspace destination overlap (deployed and verified)

Authenticated production inspection exposed two simultaneously visible full-page destinations (`Payment policy` and `Payments`). The root cause was that the sidebar's `setDestination()` only changed the active nav class; it did not hide the previously opened page layer, and the Invoice queue nav had no click handler. Commit `f4265e7` centralizes exclusive destination visibility, restores Invoice queue navigation, marks the current destination for assistive technology, makes the inbox inert while another destination is active, and ignores stale Payments/Audit responses after a navigation change. Destination surfaces use page/region semantics and their back controls return to invoices. Production deployment `dpl_HByZ8tAzY3JqTJQCHBhkNyWSQJ3j` reached `READY` and owns `https://tameion-ap-agent-live.vercel.app`. Authenticated production QA clicked through all six destinations: Invoice queue exposed no page layer; Payments and Audit trail each exposed only the shared activity page; Payment policy, Business profile, and Vendor registry each exposed only their own page; returning to Invoice queue cleared all layers. Active navigation and `aria-current` matched every destination, and browser warnings/errors were empty. `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:invoice-route`, syntax checks, and `git diff --check` pass. No financial state was mutated during verification.

### P1 — Operations destination rebuild (deployed and production-verified)

The next product UI slice is deployed without changing any API, wallet, policy, vendor, payment, or reconciliation contract. The six workspace destinations now have stable hash URLs with browser back/forward restoration. Payments uses settlement summaries, status filters, search, receipt links, and legible transaction records. Audit translates internal event keys into human-readable control events, groups them by product area, hides business UUID noise from the primary view, and retains technical JSON behind disclosure. Payment policy separates bounded limits, locked safeguards, allowance, pause, and migration controls. Vendor registry shows payment-ready/blocked summaries and separates recipient entry from the live directory. Business profile exposes the active network, wallet, vault, balance, and Gmail state beside the rename control. Mobile uses one horizontally scrollable six-destination navigation rail rather than two compressed grids.

Feature commit `46dcaf8` was pushed to `main` and reached `READY` as Production deployment `dpl_75NthZRD6ViA8QGqzw1JT3Qfkh7Z`; `https://tameion-ap-agent-live.vercel.app` serves the rebuilt destinations. Authenticated production QA loaded the real Caraxes Labs Arc Testnet account, connected Gmail, four invoices, the dedicated wallet, the active policy vault, and the existing reconciled 0.50 USDC settlement. All six destinations render exclusively, hash navigation and browser back/forward restore the correct page, Payments filters/search preserve the confirmed Arc receipt, and Audit shows friendly control labels with technical payloads collapsed. Policy, Business, and Vendors show the existing live account state without mutating it. Exact `390×844` mobile QA confirms the single scrollable navigation rail and no document-level horizontal overflow; desktop QA also passes, and browser warnings/errors are empty. No payment, allowance, vendor, policy, wallet, or network mutation was made during verification.

Local JavaScript syntax checks, `git diff --check`, `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, `npm run test:profile`, `npm run test:gmail-parser`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:idempotency`, `npm run test:migration`, and `npm run test:invoice-route` pass.

### P1 — Invoice workspace product polish (deployed and production-verified)

Commits `bc3056e`, `e8e736c`, and `17e313e` complete the next frontend polish slice without changing any wallet, policy, vendor, invoice, payment, or reconciliation API contract. The invoice queue now has payment-state filters, search, accurate counts, clear selected-row semantics, and a dedicated no-results recovery action. Initial inbox and activity reads use accessible skeleton states rather than briefly presenting false zero balances or empty records. The activation checklist now distinguishes completed, pending, and unavailable policy state instead of displaying a checkmark for every step, and a policy-status failure directs the operator to review rather than implying a fresh deployment is safe. Policy controls are inert while their live state is loading. Destination titles, Escape-to-inbox behavior, touch/keyboard states, and toast announcements are also consistent.

The production release reached `READY` as deployment `dpl_dxLGBuyYmJ1Bpy16ZPA5n71JRpaT`, and `https://tameion-ap-agent-live.vercel.app` serves it. Authenticated production QA loaded Caraxes Labs on Arc Mainnet with its dedicated wallet, connected Gmail, and two real invoice rows. Queue filtering plus search returned the intended Acme record, activity loading rendered skeletons before the real empty state, and the policy page completed its live read with controls unlocked and zero internal horizontal overflow. Exact `390×844` QA confirms a scrollable one-line metrics summary, compact three-step activation checklist with its CTA visible, centered/scrollable destination navigation, readable invoice amounts, and no document- or queue-level horizontal overflow. Browser warnings/errors are empty. No wallet, policy, allowance, vendor, network, scheduling, or payment write was performed during this release verification.

Local JavaScript syntax checks, `git diff --check`, `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, `npm run test:profile`, `npm run test:gmail-parser`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:idempotency`, `npm run test:migration`, and `npm run test:invoice-route` pass.

### P1 — Operator context header structure (deployed and production-verified)

The production header now separates environment selection, business identity and wallet custody, and Gmail source status/actions into three labeled responsive panels. The full wallet address has its own line, a dedicated copy control, and a separately labeled USDC balance/readiness state. Gmail reports a live evaluation count and time in plain language; connected, reauthorization-required, and service-error states are visually distinct. At tablet widths the wallet receives its own row; at phone widths all three panels stack.

Commits `9c9d779`, `1e87cbc`, and `cd723a3` are on `main`. The final UI deployment `dpl_78spbmHy5P2VVX5UQ4nt12qivvxQ` is `READY` for Production and owns `https://tameion-ap-agent-live.vercel.app`. Authenticated live QA restored Caraxes Labs on Arc Testnet with its dedicated Circle wallet, 39.45 USDC display balance, live Gmail, and four invoice records. Desktop QA confirms the full wallet address is on one line with the copy action visible. Exact 390×844 viewport QA confirms the stacked panels, full address, visible balance and inbox controls, and no horizontal overflow. The selected Manny record remains `REVIEW`; its vendor is unverified, so payment remains disabled. No payment, wallet, policy, allowance, vendor, environment, or schedule write was performed during visual QA.

The full release regression run passes `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, `npm run test:profile`, `npm run test:gmail-parser`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:idempotency`, `npm run test:migration`, `npm run test:invoice-route`, both frontend JavaScript syntax checks, and `git diff --check`. The final CSS-specific correction also passes `npm run test:frontend`, JavaScript syntax validation, and `git diff --check`.

Remaining UI worklist after this pass:
- Replace native confirmation/prompt dialogs for payment, policy, vendor, and scheduling actions with accessible InboxPay dialogs that preserve every existing explicit authorization gate.
- Make invoice work the first visible priority on mobile when setup is incomplete.
- Replace letter-based navigation marks with a consistent, accessible icon set.
- Improve empty activity and recovery states, then consolidate the accumulated CSS overrides.
- Extend visual QA across keyboard-only operation, tablet widths, and high-contrast settings.

### P0 — Bounded autonomy and business wallet control (Testnet proof complete; Mainnet remains gated)

On 2026-10-15 the product gap was confirmed: production invoice ingestion was request-driven, `SCHEDULE` was a durable review queue rather than an execution schedule, and the business wallet had no withdrawal operation. The implementation was completed on `codex/autonomy-wallet-control`, passed its controlled Arc Testnet proof, and was fast-forwarded into `main` at commit `f9f8f64`. No Mainnet financial write was made.

The feature branch now contains:
- durable `invoice_execution_jobs` with scheduled execution, leases, bounded retries, reconciling/held/failed terminal states, service-role-only atomic claims, and business/network isolation;
- a secret-authenticated worker action on the existing `/api/invoices` function, keeping the Vercel build at the Hobby-plan limit of 12 functions;
- business-scoped Gmail ingestion, decision audit events, automatic `PAY_NOW` queueing, preserved future execution times, payment-attempt audit events, and reuse of the existing policy-enforced/idempotent/reconciled settlement path;
- explicit per-business/per-network autonomy authorization, disabled by default, with Mainnet confirmation, ready-wallet/Gmail/vault/allowance/pause checks, a one-network authority constraint, and server-only autonomy-column mutation;
- real dedicated-business-wallet withdrawals through Circle `createTransaction`, exact confirmation, request/Circle idempotency, a one-in-flight database lock, cash-floor and autonomous-job reservations, honest pending/failure states, Arc receipt verification, history, and audit events;
- wallet UI that distinguishes balance, cash floor, reserved funds, and withdrawable funds. The active `BusinessPolicyVault` remains allowance-only: it does not custody a separate balance and exposes no withdrawal method, so no fabricated vault-recovery action was added;
- `supabase/migrations/20261015_autonomy_and_withdrawals.sql`, `AUTONOMY-RUNBOOK.md`, and `npm run test:autonomy-wallet`.

Important review findings fixed before handoff:
- an `sb_secret_...` Supabase key is sent only in `apikey`, never incorrectly as a JWT bearer token;
- browser-authenticated roles cannot toggle standing autonomy directly through PostgREST;
- Gmail token lookup is bound to the specific business;
- the autonomous settlement path resolves the job's authorized network account rather than whichever environment the UI currently displays;
- a due-date reevaluation cannot pull a stored 09:00 UTC scheduled payment forward to midnight;
- payment claims and withdrawal preparation share a database advisory-lock boundary, so they cannot independently pass balance/cash-floor checks and submit concurrently for the same business/network;
- each worker cycle is bounded to five business inboxes, five pending withdrawals, and three claimed payment jobs so it fits the existing 300-second function limit.

Local verification currently passes JavaScript syntax checks, `npm run test:autonomy-wallet`, `npm run test:frontend`, `npm run test:local`, `npm run test:networks`, `npm run test:profile`, `npm run test:gmail-parser`, `npm run test:scheduling`, `npm run test:preflight`, `npm run test:recovery`, `npm run test:idempotency`, `npm run test:migration`, `npm run test:invoice-route`, `npm run evaluate`, `forge test`, `git diff --check`, and a production-target `vercel build`. The built output still contains exactly 12 functions.

Production infrastructure completed on 2026-10-15:
- the reviewed financial branch is pushed and deployed; merging it into `main` remains gated on the controlled Testnet proof;
- `supabase/migrations/20261015_autonomy_and_withdrawals.sql` was applied successfully to the Production Supabase project;
- dedicated Production-only `SUPABASE_SECRET_KEY` and `AUTONOMY_CRON_SECRET` values are installed in Vercel; the worker secret is also stored in Supabase Vault and is not reused for any other integration;
- `pg_cron`, `pg_net`, and the `inboxpay-autonomy` every-minute trigger are active. Supabase job `1` reports `succeeded`, and the queued `pg_net` request returned HTTP `200` without timing out;
- unauthenticated and incorrect-secret worker requests return HTTP `401`;
- authenticated Production reload restores Caraxes Labs on Arc Testnet with its dedicated wallet `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`, `39.45 USDC`, connected live Gmail, ready policy vault, and authorized USDC access. Autonomy remains disabled.

The P0 release gate was the controlled Arc Testnet end-to-end proof: explicitly enable bounded authority for Caraxes Labs on Testnet, deliver or select one eligible controlled invoice, verify exactly-once autonomous settlement/reconciliation, run concurrency/rejection/delayed-reconciliation cases, and exercise one small controlled wallet withdrawal. That proof and the subsequent merge/deployment are now complete, as recorded below.

The user explicitly confirmed enabling bounded autonomy for Caraxes Labs on Arc Testnet after reporting that a new Acme test invoice was sent. Three authenticated live Gmail refreshes still returned the unchanged four-record queue (one prior Acme settlement and three review/held records), so the controlled invoice was not present in InboxPay's evaluated results. In accordance with the product's evidence-complete gate, autonomy was left disabled rather than granting standing authority without the intended invoice in view. Retry only after the message is visible and policy-eligible; the live Gmail search requires an invoice/bill/payment signal in the subject or amount/payment/balance signal in the message body, and the deterministic parser requires invoice number, amount, currency, due date, and vendor identity.

The user then resent the controlled message in the required format. On the next authenticated inspection, bounded autonomy was already enabled by a `user` audit event at 2026-10-15 11:01:24 UTC, and `AUTONOMY-TEST-002` had completed the full Arc Testnet path: one evaluation, one queue event, one execution attempt, one Circle submission (`9c1b9943-9e0a-5b65-9a8e-541f447263e1`), one completed job (`b818bcb8-aea6-4891-875f-6371921913f7`, `attempt_count=1`), and confirmed transaction `0x77f9bd481c33497a13c256198bea277f21cb3232c47b6cbf0f6fda2345369564`. Arc Testnet block `67,321,668` shows success from the dedicated Caraxes wallet to Acme's registered recipient with an exact `0.10 USDC` transfer and `0.00468617775 USDC` transaction fee. The live wallet balance became `39.344237 USDC`, daily headroom became `4,999.900000 USDC`, and the invoice/job state is `confirmed`/`completed`.

Two additional authenticated worker requests were enqueued together after completion while the minute scheduler continued running. Four recent worker calls returned HTTP `200`, but the job remained `completed` with `attempt_count=1`, `payment_submitted=1`, and `invoice_autonomy_attempted=1`; no duplicate Circle submission occurred. Production rejection evidence also remains fail-closed: Manny invoice `unique-test-001` is `ESCALATE`, both Servarica USD invoices are `HOLD`, and all three have zero execution jobs and zero Circle submissions.

The user separately confirmed a `0.01 USDC` Arc Testnet business-wallet withdrawal to `0x1DcB045123730e606A88380BCe534332F50332d2`. InboxPay enforced the `20 USDC` cash floor, recorded request `fc6e902f-f801-48e2-9a31-ee38969003a2`, submitted Circle transaction `57e52345-4206-5b2e-ad8f-864c8bae38d1`, exposed the honest `PROCESSING` state, and reconciled it on the following scheduler cycle about 51 seconds later. The final database state is `confirmed`, `reserved_usdc=0`, and transaction `0x2917d77de206099c4c8a883e2fe9f0667d34076920c625dacb226aa3c63780c8`. Arc Testnet block `67,322,348` shows success from the dedicated Caraxes wallet, an exact `0.01 USDC` transfer to the confirmed recipient, and a `0.00180409937 USDC` network fee. The live post-withdrawal wallet balance is `39.332433 USDC`, leaving `19.332433 USDC` withdrawable above the cash floor. `wallet_withdrawal_requested`, `wallet_withdrawal_submitted`, and `wallet_withdrawal_confirmed` audit events are present exactly once. This real asynchronous `PROCESSING` to `CONFIRMED` transition also supplies the delayed-reconciliation proof. The controlled Arc Testnet P0 proof is complete; Mainnet autonomy and Mainnet financial writes remain separately gated.

After the controlled proof, `codex/autonomy-wallet-control` was fast-forwarded into `main` at commit `f9f8f64` and pushed to `origin/main`. Git-triggered Vercel Production deployment `dpl_DfF14W3nR8F6nXCKHYV9TqvdyTWi` carried the release and reached `READY`; follow-up handoff-only deployment `dpl_266yiVStb21zLEVdXLnK4qDokZEY` is also `READY` and owned the canonical production alias at that point. Both were built with the required Production-only secrets. The feature is no longer branch-only. On 2026-10-15, before widening Gmail/PDF discovery, Arc Testnet autonomy for Caraxes Labs was explicitly disabled through the live policy control. Mainnet autonomy remains disabled and must not be enabled without a separate explicit confirmation.

Do not deploy or enable Mainnet autonomy without a separate controlled Mainnet authorization and proof. Vercel Hobby cron is not used because its timing cannot satisfy due-time payment execution; Supabase Cron is the selected scheduler.

### P1 — Vendor-aware Gmail and PDF discovery hardening (deployed; first sender registration verified)

The first controlled test email exposed a real ingestion blind spot: Gmail discovery only searched a narrow invoice/bill/payment keyword query. `resolveScheduleEvents()` was not involved; the message was excluded before invoice persistence. PDF extraction already existed for text-based PDFs, but a PDF-only invoice with a vague subject could be missed because the Gmail query ran before attachment inspection. HTML-only messages were also reduced to the Gmail snippet because only `text/plain` parts were parsed.

The safe remediation is intentionally narrower than scanning the whole mailbox. Arc Testnet autonomy was disabled first. The current local implementation preserves the existing strong-keyword route and adds two bounded routes only when `integrations.invoice_discovery_started_at` exists: an explicit `InboxPay` Gmail label and PDF attachments from owner-configured, verified vendor sender emails. Results from overlapping Gmail searches are deduplicated by message ID. HTML bodies are converted to deterministic text, text PDFs still use `pdf-parse`, and broadened searches fail closed when the durable start watermark is unavailable.

Financial trust is separate from discovery. `vendors.invoice_sender_emails` stores up to five owner-controlled sender identities per business/network vendor. Every Gmail-derived invoice now requires an exact sender-email match for that vendor before `PAY_NOW` or `SCHEDULE`; missing or mismatched identities produce `ESCALATE` and an operator-visible reason. The vendor API and registry UI support adding and updating these identities, require at least one before a vendor can be verified, record identity changes in `audit_events`, and require explicit confirmation for Mainnet identity changes. The migration is `supabase/migrations/20261015_vendor_aware_invoice_discovery.sql`.

The backward-compatible migration was applied to Production Supabase on 2026-10-15 and then verified read-only: the vendor sender column exists, the discovery-watermark column exists, the transactional sender-update RPC exists, and zero connected Gmail integrations are missing a watermark. No vendor identity, wallet, policy, allowance, network, autonomy authorization, or payment state was changed. Arc Testnet and Mainnet autonomy remain disabled.

Local regression coverage passes the Gmail parser/discovery tests, autonomy sender-gate tests, the full JavaScript suite, syntax checks, `git diff --check`, and a Production-target Vercel build with exactly 12 functions. The reviewed slice was committed as `5372cec` (`feat: harden Gmail invoice discovery`), pushed to `origin/main`, and released by Git-triggered Vercel Production deployment `dpl_BhsBvbvomdJuLjCmpYzgQkVrPMMJ`. The deployment reached `READY` and owns the canonical `https://tameion-ap-agent-live.vercel.app` alias.

Authenticated post-deployment QA reloaded the canonical app and verified the live Gmail queue, dedicated Caraxes Labs Arc Testnet wallet, vendor-registry sender controls, and policy page. Before sender configuration, Acme Test Hosting and Servarica both correctly showed `Sender identity missing`; the settled Acme test invoice evaluated fail-closed as `ESCALATE` rather than becoming newly payable without a configured sender identity.

The user then explicitly confirmed `akkurtkamil17@gmail.com` as the controlled Arc Testnet invoice sender for Acme Test Hosting. The production Vendor registry update succeeded: Acme now shows `Sender identity 1 verified`, remains onchain-registered, and is `PAYMENT READY`; Servarica remains blocked with no sender identity. The audit trail contains exactly one visible `Vendor invoice senders updated` business control event at 2026-10-15 17:35:15 Africa/Lagos. A subsequent live Gmail evaluation at 17:35 confirmed five invoices. Historical invoice `AUTONOMY-TEST-002` now resolves through the verified sender gate to `PAY_NOW`, but remains safely non-actionable because it is already reconciled and the onchain preflight returns `DUPLICATE_PAYMENT`. Arc Testnet policy still visibly reports `Autonomous execution disabled`. No payment, wallet, allowance, policy, environment, or autonomy write occurred during this sender-registration verification.

Controlled label-route QA on 2026-10-16 exposed a second live discovery defect before any financial action. The owner sent `IP-LABEL-HTML-20261015-01` (`0.12 USDC`, due 2026-10-31) from the connected `shallomalabi89@gmail.com` account to itself and applied a newly created `InboxPay` label. Gmail's own exact query for the stored discovery watermark returned the message, the visible Gmail account matched the production integration's provider account, and production `/api/invoices` confirmed that the `label` route was configured; however, repeated live refreshes remained at the original five invoices and 25 discovered messages. Commit `094d281` first replaced free-text `label:InboxPay` lookup with Gmail's stable custom-label ID. Commit `12ce324` then removed Gmail's inconsistent `q=after:...` parsing from this explicit-label route: it lists at most 25 messages by `labelIds`, then enforces the durable watermark against each full message's Gmail `internalDate` inside InboxPay. Missing labels and pre-watermark labeled messages still fail closed. Bounded authenticated telemetry added in `0e51e32` and `e9ebe53` proved that the label resolved, returned exactly one message, and produced one parsed record; it also exposed the actual parser boundary: Gmail's rich-text composer generated a plain alternative with Markdown-style field labels such as `*Invoice Number:*`, leaving invoice number, amount, and due date null.

Commit `422f9aa` (`fix: parse Gmail rich-text invoice fields`) normalizes only asterisk emphasis markers before deterministic extraction and includes the exact real-Gmail shape as a failing-then-passing regression. It is deployed `READY` in Production as `dpl_ExYhLMx99w9jJPHQ9Z2DrP7oE5Am` / `https://tameion-ap-agent-live-379cwoe1x-shalyxs-projects.vercel.app`, with the canonical alias still at `https://tameion-ap-agent-live.vercel.app`. Authenticated post-deployment refresh increased the queue from five to six invoices and persisted `IP-LABEL-HTML-20261015-01` with vendor `Acme Test Hosting`, amount `0.12 USDC`, due date `2026-10-31`, Gmail-email source, high extraction confidence, and both `keyword` and `label` discovery evidence. Because `shallomalabi89@gmail.com` is not the configured Acme invoice sender, the durable decision is `ESCALATE` with the visible reason `Invoice sender identity is not verified for this vendor; broadened discovery is review-only.` Settlement remains unsubmitted, no autonomy job exists, and the production payment control is disabled as `Payment blocked`. Arc Testnet autonomy remains disabled. No payment, wallet, policy, allowance, vendor, network, or autonomy mutation occurred. This completes the live labeled-message, Gmail-rich-text-alternative, and unknown-sender fail-closed proof.

Remaining live ingestion QA requires controlled messages for a strict HTML-only transport and a text-based PDF invoice from the verified sender. Unit coverage already proves HTML conversion, while the live Gmail composer proof covered its multipart rich-text/plain alternative. Sending additional messages is representational communication and remains separately gated on explicit user authorization. Scanned/image-only or encrypted PDFs remain review-only; OCR is not implemented.

Read-only follow-up QA on 2026-10-16 found one genuine text PDF from the configured Acme sender `akkurtkamil17@gmail.com`: `Invoice-227342.pdf`, received 2026-10-15 at 16:17 Africa/Lagos. That message predates the durable discovery watermark (`2026-10-15T16:01:46.270346Z`, or 17:01:46 Africa/Lagos), so the production route correctly excludes it rather than silently broadening its historical scan. The exact downloaded attachment was passed through the production `pdf-parse` and deterministic invoice parser locally without modifying Gmail or InboxPay state. It produced invoice number `227342`, amount `5`, currency `USD`, due date `Sunday, June 28, 2026`, and high extraction confidence. This proves the real attachment is text-extractable and the parser path accepts it, but it does not complete the end-to-end post-watermark verified-sender discovery proof. That proof still requires the registered sender to send or resend a fresh PDF. `npm run test:gmail-parser` and `npm run test:autonomy-wallet` pass, and the working tree remains otherwise clean.

At the user's explicit confirmation, the connected owner Gmail account sent `akkurtkamil17@gmail.com` a controlled request on 2026-10-16 at 15:36 Africa/Lagos for a fresh text-based PDF invoice numbered `IP-PDF-20261016-01`, totaling `0.13 USDC` and due 2026-10-31. Gmail Sent verifies that the request was sent. The message explicitly states that no payment is authorized automatically, and Arc Testnet autonomy remains disabled. The live end-to-end verified-sender PDF ingestion proof is pending receipt of that fresh attachment; no payment, vendor, wallet, policy, allowance, network, or autonomy setting was changed.

The next authenticated refresh at 15:53 Africa/Lagos exposed a separate production discovery defect before the requested attachment arrived: Gmail's broad keyword route returned the owner's outbound request from the Sent mailbox, and InboxPay persisted it as a seventh high-confidence invoice. The existing financial gates failed closed: its malformed vendor was not registered, the decision was `ESCALATE`, the payment control was disabled, and no settlement or autonomy job was submitted. Gmail still showed only Kamil's older October 15 PDF attachment, so the verified-sender PDF proof remains pending. A narrow local fix now rejects any fetched Gmail message carrying Gmail's system `SENT` label before text or attachment parsing, independent of keyword, custom-label, or verified-vendor discovery route. The regression suite covers both keyword-discovered and explicitly labeled outbound messages. All JavaScript checks, `git diff --check`, and a Production-target Vercel build pass. Deployment of this fix is pending; the already persisted false-positive invoice remains in Production until an explicitly authorized cleanup is performed.

The user explicitly authorized deployment and cleanup. Commit `93d0698` (`fix: exclude outbound Gmail from invoice discovery`) was pushed to `main`; Git-triggered Vercel Production deployment `dpl_4KWEqgYYfxqfxLpe7gBMWWDFWiA9` reached `READY` at `https://tameion-ap-agent-live-46r4f9nna-shalyxs-projects.vercel.app` and owns the canonical production alias. Before cleanup, the exact false-positive row `027b1489-2db9-47f4-be9a-f32584fe9ff4` was verified as Arc Testnet, `ESCALATE`, no settlement status, no transaction hash, and zero execution jobs. A guarded Production SQL delete removed exactly that row; its single evaluation audit event was preserved by the existing `ON DELETE SET NULL` foreign key. The authenticated canonical app then refreshed against live Gmail at 16:21 Africa/Lagos and remained at six invoices, proving the same outbound message was not re-ingested. There are zero policy-eligible invoices, and no payment, wallet, vendor, policy, allowance, network, or autonomy state changed. The fresh verified-sender PDF proof is still pending Kamil's new attachment.

The verified sender `akkurtkamil17@gmail.com` then sent the controlled attachment `IP-PDF-20261016-01.pdf` to the connected business inbox. Production Gmail discovery found the message after a short indexing delay and persisted invoice `IP-PDF-20261016-01` as Acme Test Hosting, `0.13 USDC`, due `2026-10-31`, with high extraction confidence and bounded decision `SCHEDULE`; payment remained unsubmitted, Arc Testnet autonomy remained disabled, and the policy-vault/onchain authorization gates remained closed. This did **not** complete the PDF proof: the UI showed only one email evidence source, and the audit trail recorded `invoice_ingestion_review_required` for the exact attachment with `reason: "DOMMatrix is not defined"`. The invoice was visible only because its email body repeated the structured fields. The production runtime bug is therefore isolated to `pdf-parse` loading without the DOM geometry globals its PDF.js dependency expects.

A test-driven local fix now loads `DOMMatrix`, `ImageData`, and `Path2D` explicitly from the existing `@napi-rs/canvas` dependency before dynamically importing `pdf-parse`, via `lib/pdf-runtime.mjs`. `lib/gmail-live.mjs` uses that shared extractor and destroys the parser in a `finally` block. The regression first failed because the runtime bootstrap did not exist, then passed after the fix; extraction of the exact controlled PDF succeeds locally. The full JavaScript suite, `npm run evaluate`, and a Production-target Vercel build pass with exactly 12 functions. The generated `api/invoices` function trace now includes the native canvas package and platform binary. Deployment and the final live refresh remain pending; the acceptance condition is that the same Gmail message updates to both `gmail-email` and `gmail-pdf` evidence without creating another extraction-review event or moving funds.

Commit `dc3ad5e` (`fix: initialize PDF runtime globals`) was pushed to `main` and Git-triggered Production deployment `dpl_F8uMh4i3ymETaYonQebuU29F6ooe` reached `READY` at `https://tameion-ap-agent-live-crt783igs-shalyxs-projects.vercel.app` with the canonical alias. The live retry proved that the DOM globals were fixed, then exposed a second serverless trace failure: `pdfjs-dist/legacy/build/pdf.worker.mjs` was absent from `/var/task`, producing `Setting up fake worker failed`. Both the controlled PDF and the older post-watermark verified-sender PDF recorded this new review reason; neither moved funds. A second test-driven patch now loads `pdf-parse/worker`, configures `PDFParse` with its packaged worker data, and protects that setup with a regression assertion. The full JavaScript suite and Production-target build pass again; the generated invoice function is approximately 35 MB and explicitly contains both `pdf-parse/dist/worker/pdf.worker.mjs` and `pdfjs-dist/legacy/build/pdf.worker.mjs`.

Commit `cbbf930` (`fix: bundle PDF worker for production ingestion`) is now pushed to `main`. Git-triggered Vercel Production deployment `dpl_3wVuo3HsDBGWkHEdwcFm6ZMjQZCA` reached `READY` and owns `https://tameion-ap-agent-live.vercel.app/`; the production page returns HTTP `200`. The unauthenticated `/api/invoices` endpoint returns HTTP `401` as designed. Live Gmail re-evaluation could not be performed in this session because local browser control is disabled and the private API requires the owner's authenticated session. Therefore the PDF fix is deployed, but final acceptance still requires refreshing Gmail in the authenticated InboxPay UI and confirming invoice `IP-PDF-20261016-01` now shows both `gmail-email` and `gmail-pdf` sources with no new extraction-review event. No funds were moved; autonomy remains disabled and payment authorization gates remain closed. The local controlled-PDF extraction, full JavaScript suite, and Production-target Vercel build passed before deployment.

The authenticated retry showed the controlled invoice still at one evidence source, so the deployed worker fix did not yet complete acceptance. A second ingestion edge case was isolated: Gmail can return a small PDF's bytes inline in `part.body.data` instead of providing `part.body.attachmentId`; the previous code skipped that part entirely. A regression test now covers inline bytes, and `getGmailAttachmentBytes()` accepts either representation while preserving the attachment-download path. Focused Gmail parsing, local runtime, frontend, and evaluator checks pass. Commit `b615145` is pushed to `main`; Production deployment `dpl_BU7cFchSux8R62Gm5bFwUAHXFThk` reached `READY` and owns the canonical alias. The next authenticated refresh remains the acceptance check; no financial state changed.

The pre-`b615145` authenticated invoice view still showed `IP-PDF-20261016-01` with one Gmail evidence source and the historical `Vendor is not verified in the payment registry` reasoning while the live preflight displayed the current registry row as verified. This is stale persisted evaluation context, not authorization to pay; the invoice remains blocked. Vercel runtime diagnostics also show repeated Arc Testnet RPC failures at `https://rpc.testnet.arc.network/` while reading wallet balance, daily spend, and `canExecute`, so those gates correctly remain unavailable and fail closed. Recheck after the inline-PDF deployment; no payment or other financial write occurred.

Commit `3d02020` adds sanitized Production logs for each PDF part (`parsed` with byte count or `review` with the parser reason) so the remaining one-source result can be diagnosed from the next authenticated refresh. Deployment `dpl_Cno66KaqEWENiH61r4Joe2m8iCTB` reached `READY` and owns the canonical alias. This is observability only; no invoice, vendor, wallet, policy, allowance, or payment state is changed.

The authenticated Production refresh after that observability release completed the attachment-runtime proof. Deployment `dpl_HExuVWmZkhWSRXUQC8YA1L59rtTL` logged `IP-PDF-20261016-01.pdf` as parsed with all `2,646` bytes and a detected invoice number; the live API reported zero extraction reviews and persisted the source as `gmail-pdf`. The remaining one-source result was therefore not an attachment download or PDF.js failure. It exposed a downstream identity bug: the structured email body named `Acme Test Hosting`, while the PDF contained no vendor field and correctly fell back to sender display name `Kamil Akkurt`. `evaluateInvoiceRecords()` included vendor in its grouping key, split the two records, and `persistInvoice()` subsequently collapsed both against the same Gmail message/invoice identity so the last record overwrote the first.

A test-driven correction now groups records by Gmail thread/message, invoice number, and sender identity rather than the parsed/fallback vendor label. `parseInvoiceText()` records whether the vendor came from invoice content or sender fallback; an explicit document vendor outranks fallback during representative selection. Multiple conflicting explicit vendor identities remain fail-closed with `ESCALATE`. The exact controlled-message regression now evaluates one `Acme Test Hosting` invoice with both `gmail-email` and `gmail-pdf` evidence, source count `2`, and the expected bounded `SCHEDULE` decision. The full JavaScript regression suite and a Production-target Vercel build pass.

Commit `57a0edb` (`fix: merge Gmail PDF invoice evidence`) is pushed to `main`. Git-triggered Production deployment `dpl_8ZmTsZmz4cVKNiaL8uGj9YrFDm1i` reached `READY` at `https://tameion-ap-agent-live-raxlwoeuj-shalyxs-projects.vercel.app` and owns the canonical alias. Authenticated post-deployment evaluation reports zero extraction reviews and now persists `IP-PDF-20261016-01` exactly once as `Acme Test Hosting`, `0.13 USDC`, due `2026-10-31`, high confidence, with `sourceCount: 2` and sources `gmail-email` plus `gmail-pdf`. The UI shows `2 Sources`, decision `SCHEDULE`, and the verified sender/vendor gate. Payment remains unsubmitted and blocked because the bounded decision is not `PAY_NOW`, the recipient is not registered in the active policy vault, USDC authorization is absent, and Arc Testnet RPC reads for daily headroom, balance/cash floor, and `canExecute` remain unavailable. No schedule action, payment, vendor mutation, policy change, allowance, wallet transfer, network change, or autonomy authorization occurred. The controlled live PDF-ingestion proof is complete.

The unavailable Arc Testnet reads were then traced to a stale hostname rather than an onchain or policy-vault failure. InboxPay's code fallback and Production `ARC_TESTNET_RPC_URL` still used `https://rpc.testnet.arc.network`; Arc's current official documentation specifies `https://rpc.testnet.arc.io` for chain ID `5042002` and lists the old connection-failure remedy as switching to a current endpoint. Production configuration is updated to the canonical `.io` endpoint. The local fallback now matches it, exports a regression-testable network mapping, and throws on unknown networks instead of silently treating them as Testnet. Network-isolation, preflight, recovery, local-server, frontend, syntax, diff, and Production-build checks pass.

Commit `d19ed45` (`fix: update Arc Testnet RPC endpoint`) is pushed to `main`. Production deployment `dpl_4QYk9aqKq7pfuboxyK5rC5bsDVML` reached `READY` at `https://tameion-ap-agent-live-lcuztnfcq-shalyxs-projects.vercel.app` and owns the canonical alias. Authenticated reads now return HTTP `200` for wallet, policy, and invoice preflight: Caraxes Labs has `39.332433 USDC`, `19.332433 USDC` withdrawable above its `20 USDC` cash floor, the policy vault is ready and unpaused, USDC authorization is present, Acme is onchain-registered, daily headroom is `5000 USDC`, and `canExecute` returns `ALLOWED`. `IP-PDF-20261016-01` remains correctly ineligible only because its bounded decision is `SCHEDULE`, not `PAY_NOW`; settlement is still unsubmitted. No schedule action or financial/configuration authority was granted during verification. The Arc Testnet read-path recovery is complete.

### Production operations hardening (2026-10-16)

The production-operations slice now adds an authenticated **Operations** destination without increasing the Vercel function count. `GET /api/activity?view=operations` reuses the existing activity function and runs bounded, read-only checks for the active business/network:

- Gmail authorization and profile reachability, without broadening invoice discovery or returning message content;
- the business's dedicated Circle wallet and Arc USDC asset;
- Arc RPC reachability plus exact chain-ID verification (`5042002` Testnet / `5042` Mainnet);
- Supabase access to the business-scoped durable job, withdrawal, and reconciliation rows;
- unresolved recovery state classified as bounded automatic recovery or operator attention.

The view does not create a wallet, scan invoices, submit or retry a payment, register a vendor, change policy, approve USDC, withdraw funds, or switch networks. Gmail may refresh the existing short-lived read-only access token. External checks have explicit time bounds; provider failures are independently represented so one unavailable integration does not hide the other service states. Error details are reduced to safe operator categories instead of exposing credentials or raw provider output.

Recovery visibility is derived from the existing `invoice_execution_jobs`, `wallet_withdrawals`, and invoice settlement state. `queued`, recent `leased`, `retry`, `reconciling`, and recent `processing` records appear as recovering; terminal/review or stale records require attention. Invoice rows already represented by a durable job are deduplicated in the operator queue. No new database migration or payment authority was added.

`AUTONOMY-RUNBOOK.md` now documents the state meanings and incident playbooks for Gmail, Circle, Arc RPC, Supabase, and reconciliation. The full JavaScript regression suite passes, including the new operations-health tests, the locally cached production dependency audit reports zero vulnerabilities, and a Production-target Vercel build succeeds with exactly 12 functions.

Commit `2ccdfcd` (`feat: add production operations health`) is pushed to `main`. Git-triggered Production deployment `dpl_44xRN534346Axawea3NHR9krFLxn` reached `READY` at `https://tameion-ap-agent-live-n7hp93efz-shalyxs-projects.vercel.app` and owns the canonical `https://tameion-ap-agent-live.vercel.app` alias. Authenticated production verification for Caraxes Labs on Arc Testnet returned **Healthy**, **5 / 5** services healthy, and **0** unresolved recovery records. Gmail, the dedicated Circle wallet/USDC asset, Arc RPC chain identity, Supabase durable queues, and reconciliation each passed a fresh read. The manual refresh reproduced the same result, navigation remained isolated to the Operations page, and the browser console contained no warnings or errors. The screenshot proof is stored locally at `output/qa/operations-health-production-proof.png` and remains intentionally untracked. No invoice scan, payment, vendor mutation, policy change, allowance, withdrawal, wallet provisioning, network change, or autonomy authorization occurred during verification.

The public-repository hygiene pass found no tracked `.env`, OAuth credential file, Gmail token, private key, `output/` artifact, or historical commit of the known local credential filenames. Secret-pattern hits were environment-variable names, documented key prefixes, and Supabase role names rather than values. The internal Circle wallet ID was removed from the public deployment proof and from the proof scripts that generate it; public addresses and transaction hashes remain as intentional onchain evidence. The locally cached production-dependency advisory check reports zero vulnerabilities; the live npm advisory endpoint was unreachable from this environment, so a fresh registry-backed audit should still be rerun before final submission. The repository is now licensed under the standard Apache License 2.0, with the canonical text in `LICENSE` and the README linking it.

### P1 — Final submission hygiene
Before hackathon submission:
- verify public repo
- verify live product URL
- verify demo recording under the required length
- verify screenshots/product branding
- verify README and handoff are current
- verify no secrets or private artifacts are committed

### Final frontend/accessibility and submission pass (2026-10-17, complete)

- Official Tameion requirements were rechecked against the event site: public repository, demo under three minutes, optional live link strongly encouraged, and judging weighted 30% agentic sophistication, 30% traction, 20% Circle usage, and 20% innovation.
- The authenticated production visual pass found a real responsive cascade defect at the 801–1040px range. An older rule converted each navigation group to four columns while a newer rule retained the desktop sidebar, causing overlapping navigation labels and collapsing the invoice queue column.
- The local correction defines a single 801–1180px tablet/small-laptop contract: persistent one-column navigation rail and a one-column workspace. The existing 800px-and-below horizontal navigation remains the mobile contract.
- A keyboard skip link now targets the main content region, and non-submit controls declare `type="button"` explicitly.
- The first deployed keyboard pass found that the skip link was focusable on the signed-out page while its application target was hidden. The follow-up makes the link session-aware: hidden at the auth gate and exposed only after the application shell is visible.
- Commits `3807573` and `194aee4` are pushed to `main`. Production deployment `dpl_Bfex2hktLTdsjTKqiyptGpZcvzh2` is `READY` and owns `https://tameion-ap-agent-live.vercel.app/` and `https://inboxpay.vercel.app/`. Signed-out Production QA passes at exact 390px, 768px, 1024px, and 1440px widths with no document overflow or browser warnings/errors. The follow-up also confirms the auth page no longer exposes the application-only skip link; keyboard order begins at the labeled work-email field. The authenticated session was not available on the current primary alias, so the post-release application destination, 200% zoom, and keyboard matrix still require a fresh user sign-in. No financial, Gmail, vendor, policy, allowance, wallet, or network action occurred during this QA.
- After the user restored the authenticated session, every workspace destination rendered exclusively with the correct document title and `aria-current`, no console warnings/errors, and no writes. Exact 1024px and 390px layouts passed and the application-only skip link moved focus to `#main-content`. Exact 768px exposed a second edge case: the horizontal navigation's min-content width widened the single-column shell by roughly 33px. A local follow-up now caps the mobile shell, sidebar, content, and navigation at the viewport while preserving horizontal navigation scrolling. Deployment and the final 768px recheck remain pending.
- Production deployment `dpl_bMh7ANRrddWZe28AyDp3YugUf7JK` verified the document-width containment fix at 768px, then exposed one remaining cascade conflict at that exact boundary: older 1040px placement rules still put queue/detail children into implicit side-by-side columns. The final rule resets the workspace and all three children to a single explicit column at 800px and below.
- Commit `9ac7e15` (`fix: stack mobile workspace panels`) is pushed to `main`. Production deployment `dpl_FaNk1eYTZMWNRzyRDxUh2no3HTKV` reached `READY` at `https://tameion-ap-agent-live-nnfmd5f5g-shalyxs-projects.vercel.app` and owns both `https://inboxpay.vercel.app/` and `https://tameion-ap-agent-live.vercel.app/`.
- Final authenticated Production acceptance passed against the real Caraxes Labs Arc Testnet workspace. At 390px, 768px, 1024px, and 1440px there is no document-level horizontal overflow. The exact 768px view renders queue, detail, and execution panels sequentially at full width rather than in implicit columns. Every destination renders independently with the correct title and `aria-current`, and the skip link moves focus to `#main-content` only after sign-in. The live view showed eight Gmail invoices, two reconciled Arc settlements, the dedicated Caraxes wallet `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`, and `39.33 USDC`. Browser console messages were traced only to installed wallet-extension content scripts; InboxPay emitted none. No Gmail refresh, payment, vendor, policy, allowance, withdrawal, wallet, network, or autonomy mutation occurred during this read-only QA.
- Reviewer-facing material now lives in `docs/submission/`: truthful form copy, a 2:30 demo script, QA report, and a 16:9 demo cover. The copy explicitly separates the complete Arc Testnet autonomous AP proof from the Arc Mainnet policy/x402 proof and does not claim a genuine Mainnet AP settlement.
- `README.md` was corrected to match that evidence boundary. Public proof for the real business/user and the final hosted demo URL remain submission blockers.
- All 13 repository regression scripts, JavaScript syntax, and whitespace checks pass. A fresh registry-backed `npm audit --omit=dev` reports zero production vulnerabilities. The remaining two moderate findings belong to `uuid@9.0.1` under the local-only `@google-cloud/local-auth`; that helper is now a development dependency and is not shipped in the production runtime. The frontend/accessibility release gate is complete.
- Remaining submission work is external and evidence-dependent: record and publish the under-three-minute demo, add public proof for the real business/user if available, send verified Canteen product/traction updates, validate all final URLs signed out, and submit the form. None of those representational actions has been performed automatically.
- At the user's explicit request on 2026-10-17, the latest verified product and traction updates were published through the authenticated `arc-canteen` CLI profile `@ShalyX`. The canonical product update describes the production per-business Gmail/Circle/Arc workflow and includes the Arc Testnet business wallet, policy vault, autonomous settlement transaction, live product, and public repository. The canonical traction update reports one builder-operated production workspace, eight live Gmail invoice records, two reconciled AP invoices totaling `0.60 USDC` on Arc Testnet, and explicitly states that there is no external-customer claim and Mainnet AP volume remains `0 USDC`. The first attempt at each update was truncated because the CLI treats an empty line as submission; complete corrected entries were immediately published and verified with `arc-canteen ls`. The CLI history retains both partial and corrected entries.
- The live Google submission form was inspected field by field. `docs/submission/SUBMISSION.md` now contains copy-ready answers for every field, including project history, problem statement, technical description, traction, Arc OSS application, Circle/Arc feedback, and organizer feedback. The saved form draft currently has a repository URL in the GitHub-handle field and a `comingsoon.com` video placeholder; these must be replaced with `ShalyX` and the final public sub-three-minute demo URL before submission. The form has not been submitted.
- The final public-repository cleanup added `output/` to `.gitignore`, set the canonical live CTA to `https://inboxpay.vercel.app/`, corrected the current `arc-canteen` installation command, added the submission cover and reviewer links to the README, and completed package metadata for the public repository. The tracked-file and history scans found no committed `.env`, OAuth credentials, Gmail tokens, Circle wallet exports, private keys, or JWT-like secrets. Public deployment JSON contains only intentional onchain addresses, limits, and transaction evidence. GitHub repository metadata now uses the canonical product description and homepage.

---

## 19. Continuity rule

**This file should evolve with the project.**

Whenever Codex discovers a new architectural decision, production blocker, completed integration, important deployment, database change, or hackathon requirement, update this file immediately.

The goal is that another capable agent can open the repo tomorrow, read `AGENTHANDOFF.md`, inspect the current deployment, and continue building without needing this conversation.

**Do not optimize for preserving the conversation. Optimize for preserving the project's actual state.**
