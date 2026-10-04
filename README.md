# InboxPay

InboxPay is an autonomous accounts-payable operator built for Tameion.

It watches Gmail for invoices, extracts the payable facts, applies deterministic business checks around the agent decision, and settles approved USDC invoices through Circle's developer-controlled wallet on Arc Mainnet.

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

Gmail scanning:

npm run scan:gmail
npm run evaluate

Start the product:

npm start

Then open http://localhost:3000.

## Payment guardrails

The execution route refuses invoices unless the evaluator has marked them PAY_NOW, the currency is USDC, and the vendor is verified.

Before settlement, the contract is checked for:
- duplicate payment ID
- vendor recipient
- vault balance + cash floor
- per-transaction limit
- daily spending limit
- paused state

The payment receipt is reconciled against the vendor balance after the Arc transaction confirms.

## Deployment

This repo is intentionally framework-light: static HTML/CSS/JS plus Vercel Node functions. No frontend build step is required.

Set the production secrets in Vercel, deploy, and keep the Canteen RPC unique to the project. Do not commit Gmail tokens, Circle wallet exports, OAuth credentials, local invoice files, or evaluator output.

## Hackathon proof

The project includes a real Gmail-derived evaluator, Circle developer-controlled wallet integration, a live x402 purchase on Arc mainnet, and an Arc mainnet PaymentPolicyVault deployment. Private Gmail/OAuth/Circle artifacts stay local; demo-decisions.json is the redacted reviewer-facing sample.

## Arc mainnet proof

The production PaymentPolicyVault is deployed on Arc Mainnet at `0xa1dafca93784eeeecd081662435a5943eba73c66`.

InboxPay also completed a real x402 purchase on Arc Mainnet through Circle's developer-controlled wallet. The 0.001 USDC settlement transaction is `0x0957a0febac2b4d5757148aa8e9d36861167ef4139c20bfd5105a4b404ac0186`.

The live demo uses the same mainnet USDC rail and reads settlement state directly from the vault's `PaymentExecuted` events.

Tameion final submission requires a public GitHub repository and a recorded demo under three minutes. A live product URL is encouraged.

