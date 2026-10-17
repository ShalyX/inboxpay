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

## Final submission checklist

- [ ] Record and publish the demo at under three minutes.
- [ ] Add the video URL above.
- [ ] Add a public proof link for the real business/user if available.
- [ ] Run `arc-canteen update-product` with the latest product facts.
- [ ] Run `arc-canteen update-traction` with only verified usage and volume.
- [ ] Submit the public repo, live link, and video through the official form.
- [ ] Recheck the submitted links in a signed-out browser.
