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
   - Business wallet fields live on `businesses`.

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

Latest documented production deployment at handoff creation:
- Deployment: `dpl_EPfMxK2acjFnSmWT5NYgkeacTSWK`
- Commit: `e5fa87aefca7f8191b0c1b95ebda224f6376c738`
- Message: `Document production Gmail OAuth flow`
- State: `READY`

That deployment includes the previous auth/onboarding/frontend fixes because the docs commits were made on top of them.

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

## 7. CURRENT LIVE BLOCKER — Circle SDK import

This is the most important thing Codex should see immediately.

At the latest production runtime inspection, `/api/onboarding` produced:

`SyntaxError: Named export 'initiateDeveloperControlledWalletsClient' not found. The requested module '@circle-fin/developer-controlled-wallets' is a CommonJS module...`

Current file:
`lib/circle-wallets.mjs`

Current import is:

`import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";`

Vercel explicitly recommends the CommonJS-compatible pattern:

`import pkg from "@circle-fin/developer-controlled-wallets";`
`const { initiateDeveloperControlledWalletsClient } = pkg;`

**Do not blindly patch and assume success.**
First inspect the installed package/version and confirm its exported shape, then make the smallest compatible change.

Relevant dependency in `package.json`:
`"@circle-fin/developer-controlled-wallets": "^10.8.1"`

This blocker affects **dedicated business wallet provisioning**. It is distinct from Supabase Google login.

---

## 8. Circle / Arc state

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
- current known runtime blocker is the Circle SDK import during wallet provisioning

Do not mark the product “fully working” until the following are verified live:

### Auth
- Google login completes and stays authenticated.
- Existing business loads without duplicate-key errors.
- Email/password login/signup still works.
- Production email confirmation returns to the production origin.

### Business setup
- Dedicated Arc Mainnet wallet creation succeeds.
- Wallet details persist to the correct business row.
- A second click/request does not create another wallet or corrupt the business.

### Gmail
- Connect Gmail completes.
- Integration is bound to the correct InboxPay user/business.
- Encrypted refresh/access tokens persist.
- Refresh inbox reads the connected account.

### AP
- Real invoice appears in the queue.
- Extraction is evidence-based.
- Agent decision is bounded.
- Duplicate/vendor/currency/policy checks are visible.

### Settlement
- Approved invoice can settle from the correct business wallet.
- Mainnet confirmation is explicit.
- Actual Arc transaction hash is stored.
- Reconciliation reflects the real transaction state.
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
Inspect `lib/circle-wallets.mjs` and the installed `@circle-fin/developer-controlled-wallets` package export format.

Fix the ESM/CommonJS import incompatibility, then verify:
- Arc Testnet wallet creation
- Arc Mainnet wallet creation with confirmation
- returned wallet ID/address persistence
- repeated provisioning request behavior

### P0 — Re-run production Google auth
After wallet work does not regress auth:
- sign into production with Google
- verify existing business loads
- verify setup state renders rather than logging out
- inspect runtime logs

### P1 — Complete real Gmail connection
Use the production Connect Gmail button and verify the integration is stored against the authenticated business.

### P1 — Complete one real invoice end-to-end
Use a genuine test/business invoice email:
- ingest
- evaluate
- verify vendor
- pass policy
- settle
- reconcile

### P1 — Final submission hygiene
Before hackathon submission:
- verify public repo
- verify live product URL
- verify demo recording under the required length
- verify screenshots/product branding
- verify README and handoff are current
- verify no secrets or private artifacts are committed

---

## 19. Continuity rule

**This file should evolve with the project.**

Whenever Codex discovers a new architectural decision, production blocker, completed integration, important deployment, database change, or hackathon requirement, update this file immediately.

The goal is that another capable agent can open the repo tomorrow, read `AGENTHANDOFF.md`, inspect the current deployment, and continue building without needing this conversation.

**Do not optimize for preserving the conversation. Optimize for preserving the project's actual state.**
