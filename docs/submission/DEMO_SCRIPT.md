# InboxPay demo script

Target length: **2:30**. Hard ceiling: **2:55**.

## 0:00–0:15 — The problem

**Visual:** Start on the live invoice queue with the Gmail source, dedicated wallet, and policy state visible.

**Voiceover:**

“Invoices arrive in email, but the hard part is not reading the amount. It is deciding whether the evidence is complete, whether this exact vendor can be paid, and whether a retry could move the money twice. InboxPay runs that accounts-payable loop with bounded authority.”

## 0:15–0:42 — Real evidence in

**Visual:** Refresh the connected Gmail inbox. Open `IP-PDF-20261016-01` and show the two evidence sources.

**Voiceover:**

“This is a real Gmail connection for this business. InboxPay discovers invoice email and PDF evidence, extracts the fields, merges sources that belong to the same invoice, and preserves the evidence count. Weak or conflicting evidence fails closed.”

## 0:42–1:12 — The agent decides, the gates decide whether money can move

**Visual:** Show the invoice reasoning and readiness gates. Move to the vendor registry and payment policy.

**Voiceover:**

“The agent returns one bounded decision: pay now, hold, escalate, or schedule. That decision is only the start. The recipient must match this business's verified vendor registry, and the live preflight checks the dedicated wallet, authorization, daily headroom, cash floor, pause state, and the onchain duplicate key.”

## 1:12–1:38 — Per-business custody and onchain authority

**Visual:** Show the full Circle wallet address, Arc Testnet environment, then the policy page with limits and safeguards.

**Voiceover:**

“Every business and network has its own Circle developer-controlled wallet and its own policy vault. There is no shared treasury. The vault enforces recipient registration, per-payment and daily limits, a cash floor, emergency pause, and one-time payment IDs outside the model.”

## 1:38–2:08 — Autonomous settlement proof

**Visual:** Open settled invoice `AUTONOMY-TEST-002`, then Payments and its receipt.

**Voiceover:**

“For this controlled Testnet proof, a verified 0.10 USDC invoice entered the durable queue, the worker re-read every gate, Circle submitted one transaction, Arc confirmed it, and InboxPay reconciled the receipt. The same invoice now fails the onchain duplicate check, so it cannot be paid again.”

**On-screen proof:** `0x77f9bd481c33497a13c256198bea277f21cb3232c47b6cbf0f6fda2345369564`

## 2:08–2:28 — Production operations

**Visual:** Open Operations and show Gmail, Circle, Arc RPC, Supabase, and reconciliation health.

**Voiceover:**

“This is operated as a production system. Provider failures are separated, retries are durable, unresolved recovery is visible, and a payment is never called complete until the invoice, transaction, and reconciliation record agree.”

## 2:28–2:42 — Close

**Visual:** Return to the invoice queue and product mark.

**Voiceover:**

“InboxPay gives an agent enough authority to do useful financial work, but not enough authority to improvise with a business's money.”

## Recording rules

- Record the deployed product, not localhost.
- Keep browser zoom at 100% and hide bookmarks, personal email addresses, and unrelated tabs.
- Do not perform a new financial write for the recording. Use the existing reconciled proof.
- Say “Arc Testnet” when showing the autonomous invoice settlement.
- Do not describe the separate Mainnet x402 purchase as an invoice payment.
- Keep the transaction hash visible long enough to pause and verify.
