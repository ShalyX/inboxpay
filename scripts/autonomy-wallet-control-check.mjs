import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { autonomousExecutionTarget, autonomyFailureDisposition, preserveScheduledExecution } from "../lib/autonomy.mjs";
import { evaluateInvoiceRecords } from "../lib/evaluator.mjs";
import { withdrawalAvailability } from "../lib/wallet-withdrawals.mjs";
import { requireAutonomyWorker } from "../lib/worker-auth.mjs";

const now = new Date("2026-10-15T10:00:00.000Z");
assert.deepEqual(
  autonomousExecutionTarget({ decision: "PAY_NOW" }, now),
  { jobKind: "pay_now", scheduledFor: now.toISOString() }
);
assert.deepEqual(
  autonomousExecutionTarget({ decision: "SCHEDULE", due_date: "2026-10-20" }, now),
  { jobKind: "scheduled_payment", scheduledFor: "2026-10-20T09:00:00.000Z" }
);
assert.equal(autonomousExecutionTarget({ decision: "HOLD", due_date: "2026-10-20" }, now), null);
assert.deepEqual(
  preserveScheduledExecution(
    { job_kind: "scheduled_payment", scheduled_for: "2026-10-20T09:00:00.000Z" },
    { jobKind: "pay_now", scheduledFor: "2026-10-20T00:05:00.000Z" }
  ),
  { jobKind: "scheduled_payment", scheduledFor: "2026-10-20T09:00:00.000Z" },
  "a due-date reevaluation must not pull a scheduled payment forward"
);

const invoiceRecord = {
  threadId: "thread-1",
  messageId: "message-1",
  invoiceNumber: "INV-AUTONOMY-1",
  vendor: "Verified Vendor",
  amount: 12.5,
  currency: "USDC",
  dueDate: "2026-10-20",
  source: "gmail-body",
  extraction: { confidence: "high" },
  bodySignals: {}
};
const vendorRegistry = { "Verified Vendor": { status: "verified", currency: "USDC" } };
assert.equal(evaluateInvoiceRecords([invoiceRecord], vendorRegistry, now).invoices[0].agentDecision, "SCHEDULE");
assert.equal(
  evaluateInvoiceRecords([invoiceRecord], vendorRegistry, new Date("2026-10-20T09:00:00.000Z")).invoices[0].agentDecision,
  "PAY_NOW",
  "a future invoice must become executable when its durable schedule is due"
);

assert.equal(autonomyFailureDisposition("Blocked: vendor is not verified", 1, 5, now).status, "held");
assert.equal(autonomyFailureDisposition("Circle status temporarily unavailable", 1, 5, now).status, "retry");
assert.equal(autonomyFailureDisposition("Circle status temporarily unavailable", 5, 5, now).status, "failed");

assert.equal(withdrawalAvailability({ balance: 100_000_000n, cashFloor: 20_000_000n, reserved: 15_000_000n, feeReserve: 1_000_000n }), 64_000_000n);
assert.equal(withdrawalAvailability({ balance: 10n, cashFloor: 20n, reserved: 0n }), 0n);

const previousSecret = process.env.AUTONOMY_CRON_SECRET;
process.env.AUTONOMY_CRON_SECRET = "test-worker-secret-for-constant-time-check";
assert.equal(requireAutonomyWorker({ headers: { authorization: "Bearer test-worker-secret-for-constant-time-check" } }), true);
assert.throws(() => requireAutonomyWorker({ headers: { authorization: "Bearer wrong" } }), /authentication failed/i);
if (previousSecret === undefined) delete process.env.AUTONOMY_CRON_SECRET;
else process.env.AUTONOMY_CRON_SECRET = previousSecret;

const migration = await fs.readFile(new URL("../supabase/migrations/20261015_autonomy_and_withdrawals.sql", import.meta.url), "utf8");
assert.match(migration, /unique \(invoice_id\)/i);
assert.match(migration, /for update of jobs skip locked/i);
assert.match(migration, /auth\.role\(\) <> 'service_role'/i);
assert.match(migration, /security definer\s+set search_path = ''/i);
assert.match(migration, /policies_one_autonomous_network_per_business/i);
assert.match(migration, /revoke update on public\.policies from authenticated/i);
assert.match(migration, /revoke insert on public\.policies from authenticated/i);
assert.match(migration, /grant update \([\s\S]*max_transaction_usdc[\s\S]*paused[\s\S]*\) on public\.policies to authenticated/i);
assert.doesNotMatch(migration.match(/grant update \([\s\S]*?\) on public\.policies to authenticated/i)?.[0] || "", /autonomy_enabled/i);
assert.match(migration, /create table if not exists public\.wallet_withdrawals/i);
assert.match(migration, /wallet_withdrawals_one_processing_per_account/i);
assert.match(migration, /jobs\.status = 'reconciling' or jobs\.attempt_count < jobs\.max_attempts/i);
assert.match(migration, /enable row level security/ig);
assert.match(migration, /create or replace function public\.claim_invoice_for_payment/i);
assert.match(migration, /create or replace function public\.prepare_wallet_withdrawal/i);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_business_id::text \|\| ':' \|\| p_network, 0\)\)/i);
assert.match(migration, /business wallet withdrawal is processing/i);
assert.match(migration, /invoice payment is processing/i);

const invoiceRoute = await fs.readFile(new URL("../api/invoices.mjs", import.meta.url), "utf8");
assert.match(invoiceRoute, /action \|\| ""\)\.toLowerCase\(\) === "autonomy_tick"/);
assert.match(invoiceRoute, /requireAutonomyWorker\(req\)/);

const walletRoute = await fs.readFile(new URL("../api/wallet.mjs", import.meta.url), "utf8");
assert.match(walletRoute, /confirmWithdrawal !== true/);
assert.match(walletRoute, /confirmMainnet !== true/);

const businessVault = await fs.readFile(new URL("../contracts/BusinessPolicyVault.sol", import.meta.url), "utf8");
assert.doesNotMatch(businessVault, /function\s+withdraw\s*\(/);
assert.match(businessVault, /return token\.balanceOf\(owner\)/);

const circleWallets = await fs.readFile(new URL("../lib/circle-wallets.mjs", import.meta.url), "utf8");
assert.match(circleWallets, /sdk\.createTransaction\(/);
assert.match(circleWallets, /"business-withdrawal"/);

const supabaseServer = await fs.readFile(new URL("../lib/supabase-server.mjs", import.meta.url), "utf8");
assert.match(supabaseServer, /token\.startsWith\("sb_secret_"\)/);
assert.match(supabaseServer, /opaqueSecretKey \? \{\} : \{ Authorization:/);

console.log("Autonomy and business-wallet control checks passed");
