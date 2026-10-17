# InboxPay submission sheet

## One-line pitch

InboxPay turns a business Gmail inbox into a bounded accounts-payable operator: it reads invoice evidence, explains its decision, enforces payment authority onchain, settles USDC from that business's dedicated Circle wallet, and reconciles the receipt on Arc.

## Links

- Live product: https://tameion-ap-agent-live.vercel.app/
- Public repository: https://github.com/ShalyX/inboxpay
- License: Apache License 2.0
- Demo video: **add the final public URL after recording**

## What was built during Tameion

- Real Gmail OAuth and business-scoped invoice discovery.
- Deterministic extraction from email and text-based PDF evidence.
- Bounded `PAY_NOW`, `HOLD`, `ESCALATE`, and `SCHEDULE` decisions with visible reasons.
- A dedicated Circle developer-controlled wallet for every business and Arc environment.
- A `PaymentPolicyVault` that enforces verified recipients, per-payment and daily limits, a cash floor, pause control, and duplicate protection.
- Durable scheduling, bounded autonomous execution, retries, settlement recovery, reconciliation, wallet withdrawals, and an operator health page.
- Strict Testnet/Mainnet isolation. Mainnet writes remain explicitly gated.

## Verified product proof

### Complete autonomous AP loop on Arc Testnet

- Business: Caraxes Labs workspace
- Dedicated Circle wallet: `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`
- Policy vault: `0x59ceead805ef96fc2839388cafe937150412383a`
- Controlled invoice: `AUTONOMY-TEST-002`
- Amount: `0.10 USDC`
- Settlement transaction: `0x77f9bd481c33497a13c256198bea277f21cb3232c47b6cbf0f6fda2345369564`
- Outcome: one evaluation, one queued job, one execution attempt, one Circle submission, confirmed settlement, reconciled receipt, and no duplicate payment.

### Additional real integration proof

- Gmail email + PDF evidence merge completed in production for invoice `IP-PDF-20261016-01`.
- Arc Testnet business-wallet withdrawal completed and reconciled for `0.01 USDC`.
- Arc Mainnet policy vault deployed at `0xa1dafca93784eeeecd081662435a5943eba73c66`.
- Circle wallet completed a separate `0.001 USDC` x402 purchase on Arc Mainnet: `0x0957a0febac2b4d5757148aa8e9d36861167ef4139c20bfd5105a4b404ac0186`.

## Honest traction statement

InboxPay has one production business workspace running a real Gmail connection with live invoice and PDF ingestion. The complete autonomous invoice-payment loop has been proven on Arc Testnet. A genuine third-party vendor Mainnet invoice settlement has **not** been completed, so the submission must not describe the Testnet proof or the separate Mainnet x402 purchase as Mainnet AP traction.

Before submission, add a public proof link for the business/user if one is available and confirm the form's business count using the organizer's definition.

## Judging fit

- **Agentic sophistication (30%)**: evidence-aware decisions, deterministic fail-closed gates, durable execution, retries, reconciliation, and operator recovery.
- **Traction (30%)**: real production Gmail usage and an end-to-end business workflow; public user proof still needs to be attached.
- **Circle usage (20%)**: dedicated developer-controlled wallets, Circle transaction submission, Arc USDC, and smart-contract policy enforcement.
- **Innovation (20%)**: authority is enforced outside the model, per business and per network, with a replayable reason and receipt for every action.

## Form answers to finalize

- Team/project name: InboxPay
- RFB: AP/AR Automation Agent, with Autonomous Business Operator capabilities
- Businesses onboarded: **confirm against public business proof before entering**
- Value moved by the AP agent: `0.60 USDC` on Arc Testnet across two reconciled invoice settlements, including the `0.10 USDC` autonomous proof. Do not add the separate withdrawal or x402 purchase to AP volume.
- Mainnet AP value moved: `0 USDC`
- Problems solved: invoice discovery, evidence extraction, payment timing decisions, vendor/recipient controls, bounded execution, duplicate prevention, and reconciliation.

## Official form responses

These answers follow the live Tameion submission form as inspected on 2026-10-17. Do not put a placeholder URL in the required video field. Record and publish the final demo first.

### Contact and team

- **Email:** use the signed-in submission address; do not add it to the public repository.
- **Project Name:** InboxPay
- **GitHub Handle:** `ShalyX` (the form asks for a handle, not the repository URL)
- **Discord Handle:** `@shalyx`
- **Telegram Handle:** `@shaly00`
- **Twitter / X Profile:** https://x.com/shalyx_04
- **Number of Team Members:** 1 (Solo)
- **Team Members Names:** Shaly
- **Prior Canteen × Arc participants:** `ShalyX`

### Existing-project and Tameion progress

InboxPay itself was built during Tameion. I have participated in prior Canteen × Arc programs under `ShalyX`, but I am not claiming a prior award or grant for InboxPay. During Tameion I built the production workflow from Gmail ingestion through policy-bound USDC settlement and reconciliation. The work includes real Gmail OAuth, email and text-PDF extraction, a vendor registry, explainable bounded decisions, a dedicated Circle developer-controlled wallet per business and network, an onchain PaymentPolicyVault, durable autonomous execution and retries, reconciliation, wallet controls, operator recovery states, and a production accessibility pass. The complete AP loop has been proven on Arc Testnet. Mainnet infrastructure and a separate x402 purchase are also proven, but a genuine Mainnet AP settlement has not been completed.

### Problem Statement

Small businesses still run accounts payable through inboxes, spreadsheets, and manual wallet actions. The hard part is not reading an invoice. It is deciding whether that invoice is trustworthy, whether the business has authorized the recipient and amount, whether the payment fits live spending policy, and whether a submitted transaction actually settled. Giving an AI unrestricted wallet access is not an acceptable shortcut. InboxPay solves the full control problem: it turns Gmail evidence into an explainable payment decision, enforces authority outside the model, and keeps the final receipt tied to the original invoice.

### Project Description

InboxPay is a bounded accounts-payable operator for real businesses. It connects to a business Gmail inbox, discovers invoice emails and text-based PDF attachments, extracts the invoice facts, and produces one of four explicit decisions: `PAY_NOW`, `HOLD`, `ESCALATE`, or `SCHEDULE`. Before funds can move, deterministic checks verify the sender, vendor recipient, currency, duplicate state, per-payment limit, daily headroom, cash floor, wallet balance, emergency pause, and live onchain execution result.

Every business and Arc environment has its own Circle developer-controlled wallet, vendor registry, policy, and PaymentPolicyVault. Eligible payments enter a durable queue, execute through Circle on Arc, and remain in a processing state until reconciliation confirms the transaction. Operators can inspect audit events, recovery states, service health, and receipts. The production stack uses Gmail OAuth, Circle Developer-Controlled Wallets, Arc USDC, Solidity, Supabase, Vercel Functions, and a framework-light JavaScript frontend.

The strongest proof is `AUTONOMY-TEST-002`: one Gmail evaluation, one queued job, one execution attempt, one Circle submission, a confirmed `0.10 USDC` Arc Testnet settlement, and one reconciled receipt with duplicate protection confirmed.

### Traction

InboxPay currently has one production business workspace, Caraxes Labs, operated by the builder against a real connected Gmail inbox. This is verified internal business usage, not an external-customer claim. The workspace has processed eight live Gmail invoice records, including merged email and PDF evidence. Two AP invoices totaling `0.60 USDC` were settled and reconciled on Arc Testnet. The strongest autonomy proof moved `0.10 USDC` exactly once from the dedicated business wallet under the onchain policy vault.

Business wallet: `0xca32c823b85c2b5de03c7626b42293b4fe18d5e2`

Policy vault: `0x59ceead805ef96fc2839388cafe937150412383a`

Autonomous settlement: `0x77f9bd481c33497a13c256198bea277f21cb3232c47b6cbf0f6fda2345369564`

A genuine third-party vendor Mainnet AP settlement has not been completed, so Mainnet AP volume remains `0 USDC`. The separate Mainnet x402 purchase is product proof, not AP traction.

### Links

- **Project Source Code:** https://github.com/ShalyX/inboxpay
- **Existing-project comparison link:** `N/A — InboxPay was built during Tameion.`
- **Project Live:** https://inboxpay.vercel.app/
- **Project Video Demo:** **pending final public YouTube, Loom, or Vimeo URL; must be under three minutes**

### Arc Open Source Showcase

- **Apply:** Yes. The repository is public and licensed under Apache License 2.0.
- **Why InboxPay:** InboxPay exposes a complete business-payment control plane rather than a single wallet or contract example. Builders can reuse the per-business/per-network Circle wallet provisioning pattern, Gmail and PDF evidence pipeline, bounded invoice decision model, vendor-sender verification, `PaymentPolicyVault`, durable execution and retry queue, duplicate-safe reconciliation, withdrawal controls, and operations-health surface. The existing Circle Arc samples are valuable protocol demonstrations. InboxPay adds the production glue required to turn those primitives into a multi-business AP operator with visible reasons, explicit authority, recovery states, and receipts.

### Circle / Arc feedback

Circle Developer-Controlled Wallets and Arc's EVM compatibility made it possible to keep custody business-scoped while enforcing policy in a contract. Arc Testnet confirmation was fast enough for an operator-facing reconciliation loop, and Circle transaction IDs gave the system a durable handle before an onchain hash was available. The rough edges were integration packaging and operational clarity. The developer-controlled-wallet SDK's ESM/CommonJS behavior required a compatibility repair, and serverless deployments would benefit from a clearer supported-import example. Circle and Arc documentation would also benefit from one canonical, versioned page for chain IDs, RPC endpoints, USDC addresses, SDK/runtime compatibility, and endpoint changes, plus stronger examples for pending transaction recovery and reconciliation.

### Organizer feedback

The strongest part of Tameion was the repeated emphasis on real usage and verifiable onchain proof. The product and traction CLI updates also forced progress to be documented before the deadline. For future events, publish the exact submission-form fields and evidence checklist earlier, and make the CLI editor's input behavior clearer: an empty line currently submits immediately, which makes accidental partial updates easy. It would also help if builders could replace or mark a corrected update as canonical instead of leaving partial entries beside the final version.

### Optional call

Select **Yes** only if you are personally available for a 20-minute Circle/Arc feedback call.

## Final submission checklist

- [ ] Record and publish the demo at under three minutes.
- [ ] Add the video URL above.
- [ ] Add a public proof link for the real business/user if available.
- [x] Run `arc-canteen update-product` with the latest product facts.
- [x] Run `arc-canteen update-traction` with only verified usage and volume.
- [ ] Submit the public repo, live link, and video through the official form.
- [ ] Recheck the submitted links in a signed-out browser.
