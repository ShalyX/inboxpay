# InboxPay

InboxPay is an autonomous accounts-payable operator built for Tameion.

Each business gets its own InboxPay account, Gmail integration, AP policy, vendor registry, and Circle developer-controlled wallet. The agent reads the business's real invoice inbox, makes a bounded payment decision, and settles approved USDC invoices from that business wallet on Arc Mainnet.

## The product

Gmail / PDF invoice
→ extraction
→ duplicate + currency + vendor checks
→ agent decision
→ policy vault
→ Circle transaction signing
→ Arc USDC settlement
→ reconciliation + receipt

The key design choice is that the model does not get to invent its own spending authority. The execution path is bounded by a smart-contract vault with vendor allowlisting, per-transaction limits, daily limits, a cash floor, pause control, and onchain duplicate-payment protection.

## Local setup

Use Node.js 20+.

Install dependencies:

npm install

Authenticate the Canteen Arc CLI and export the unique Canteen RPC:

uv tool install git+https://github.com/the-canteen-dev/ARC-cli
arc-canteen login
arc-canteen rpc-url --export

The app expects the resulting RPC as ARC_RPC_URL or the exported RPC value.

Circle credentials are read from the existing local environment. For production, configure CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS, PAYMENT_VAULT_ADDRESS, and ARC_RPC_URL.

### Gmail integration

Users do not enter Gmail client IDs, client secrets, or refresh tokens. After signing into InboxPay, they click **Connect Gmail** and complete a Google OAuth consent flow for the Gmail account that actually carries the business's invoices.

The OAuth callback binds the Google connection to the authenticated InboxPay user, encrypts the provider tokens before persistence, and stores only the minimum integration metadata in Supabase. Invoice bodies and PDF contents are never written to Git.

Google refresh tokens are used only server-side to refresh short-lived access tokens when InboxPay syncs the user's inbox.

### Local Gmail scanning

npm run scan:gmail
npm run evaluate

Start the product:

npm start

Then open http://localhost:3000.

## Multi-business execution

Every business owns a separate Circle wallet. The agent never selects a global treasury wallet at runtime.

The execution route refuses invoices unless the evaluator has marked them PAY_NOW, the currency is USDC, the business is not paused, the vendor is verified, the payment is inside the business's per-transaction and daily limits, and the business wallet remains above its configured cash floor.

Before settlement, the contract is checked for:
- duplicate payment ID
- vendor recipient
- vault balance + cash floor
- per-transaction limit
- daily spending limit
- paused state

The payment receipt is reconciled against the vendor balance after the Arc transaction confirms.

## Deployment

This repo is intentionally framework-light: static HTML/CSS/JS in `public/` plus native Vercel Node functions under `api/`. There is no frontend build step. `dev-server.mjs` is for local development only; production API traffic goes directly to the Vercel functions.

Set the infrastructure secrets in Vercel, including Circle credentials, Supabase configuration, Gmail OAuth client credentials, and token-encryption secrets. Users supply their own OAuth consent through the product; they never configure infrastructure secrets.

Do not commit Gmail tokens, Circle wallet exports, OAuth credentials, local invoice files, or evaluator output.

## Hackathon proof

The project includes a real Gmail-derived evaluator, Circle developer-controlled wallet integration, a live x402 purchase on Arc mainnet, and an Arc mainnet PaymentPolicyVault deployment. Private Gmail/OAuth/Circle artifacts stay local; demo-decisions.json is the redacted reviewer-facing sample.

## Arc mainnet proof

The production PaymentPolicyVault is deployed on Arc Mainnet at `0xa1dafca93784eeeecd081662435a5943eba73c66`.

InboxPay also completed a real x402 purchase on Arc Mainnet through Circle's developer-controlled wallet. The 0.001 USDC settlement transaction is `0x0957a0febac2b4d5757148aa8e9d36861167ef4139c20bfd5105a4b404ac0186`.

The live demo uses the same mainnet USDC rail and reads settlement state directly from the vault's `PaymentExecuted` events.

Tameion final submission requires a public GitHub repository and a recorded demo under three minutes. A live product URL is encouraged.



## Product onboarding

1. A business creates an InboxPay account.
2. InboxPay provisions a dedicated Circle developer-controlled wallet and records its wallet address.
3. The business connects the Gmail account used for invoices.
4. The business registers vendor settlement addresses and configures AP limits.
5. InboxPay continuously evaluates real invoice evidence and settles approved USDC payments from that business wallet.

The hackathon evaluates genuine business usage and real USDC activity during the event window, so the production path intentionally requires a real connected business inbox rather than a synthetic invoice dataset.
