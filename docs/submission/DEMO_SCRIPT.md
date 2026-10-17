# InboxPay demo script

Target length: **2:45**. Hard ceiling: **2:55**.

## 0:00–0:14 — The problem

**Visual:** Open directly on the live invoice queue. Keep the invoice list, Gmail status, dedicated wallet, and “Settled” count visible from the first frame.

**Voiceover:**

“Businesses receive invoices by email, then someone still has to verify them, decide what can be paid, move the money, and make sure a retry does not pay twice. InboxPay runs that accounts-payable loop with bounded authority.”

## 0:14–0:39 — Real evidence in

**Visual:** Point to “Live Gmail evaluated,” then open `IP-PDF-20261016-01`. Hold on the invoice facts, `2 Sources`, and the visible email/PDF evidence. Do not wait on a fresh scan during the recording.

**Voiceover:**

“This is a real Gmail connection for this business. InboxPay discovers invoice email and PDF evidence, extracts the fields, merges sources that belong to the same invoice, and preserves the evidence count. Weak or conflicting evidence fails closed.”

## 0:39–1:08 — The agent decides, the gates decide whether money can move

**Visual:** Show the invoice reasoning and readiness gates. Move to the vendor registry and payment policy.

**Voiceover:**

“The agent returns one bounded decision: pay now, hold, escalate, or schedule. That decision is only the start. Application preflight checks the evidence, sender, verified vendor, USDC currency, dedicated wallet, authorization, settlement state, and the recipient registered for this business.”

## 1:08–1:38 — Per-business custody and onchain authority

**Visual:** Show the full Circle wallet address and Arc Testnet environment. Move to the policy page. Use two short on-screen labels while the relevant controls are visible:

- `Application preflight: evidence · identity · currency · wallet · authorization · settlement state`
- `Onchain vault: recipient · payment limit · daily limit · cash floor · pause · duplicate ID`

**Voiceover:**

“Every business and network has its own Circle developer-controlled wallet and policy vault. There is no shared treasury. The application rejects incomplete or unauthorized work before submission. Onchain, the vault enforces the registered recipient, payment and daily limits, cash floor, pause state, and one-time payment ID outside the agent.”

## 1:38–2:14 — Autonomous settlement proof

**Visual:** Open settled invoice `AUTONOMY-TEST-002`, then its Payments record and receipt. Cut to a clean proof card for at least six seconds. Reveal each verified line in sequence and leave the completed card on screen long enough to pause:

- `✓ 1 evaluation`
- `✓ 1 queued job` — `b818bcb8-aea6-4891-875f-6371921913f7`
- `✓ 1 execution attempt`
- `✓ 1 Circle submission` — `9c1b9943-9e0a-5b65-9a8e-541f447263e1`
- `✓ 0.10 USDC confirmed on Arc Testnet`
- `✓ 1 reconciled receipt`
- `✓ Duplicate protection: DUPLICATE_PAYMENT`

**Voiceover:**

“This is the autonomous proof, not a mocked walkthrough. One evaluation created one queued job. The worker made one execution attempt. Circle accepted one submission. Arc Testnet confirmed 0.10 USDC, and InboxPay recorded one reconciled receipt. Rechecking the same invoice now returns duplicate payment, so it cannot execute again.”

**On-screen transaction:** `0x77f9bd481c33497a13c256198bea277f21cb3232c47b6cbf0f6fda2345369564`

## 2:14–2:34 — Production operations

**Visual:** Open Operations and show Gmail, Circle, Arc RPC, Supabase, and reconciliation health.

**Voiceover:**

“This is operated as a production system. Provider failures are separated, retries are durable, unresolved recovery is visible, and a payment is never called complete until the invoice, transaction, and reconciliation record agree.”

## 2:34–2:47 — Close

**Visual:** Return to the invoice queue and product mark.

**Voiceover:**

“InboxPay gives an agent enough authority to do useful financial work, but not enough authority to improvise with a business's money.”

## Recording rules

- Record the deployed product, not localhost.
- Keep browser zoom at 100% and hide bookmarks, personal email addresses, and unrelated tabs.
- Do not perform a new financial write for the recording. Use the existing reconciled proof.
- Use “agent,” never “AI,” in narration and on-screen copy.
- Do not imply that application preflight checks are all enforced by the contract. Preserve the split stated in the script.
- Say “Arc Testnet” when showing the autonomous invoice settlement.
- Do not describe the separate Mainnet x402 purchase as an invoice payment.
- Keep the transaction hash visible long enough to pause and verify.
- Keep the complete autonomous-proof card visible for at least six seconds.
