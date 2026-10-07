import assert from "node:assert/strict";
import { buildPaymentPreflight } from "../lib/payment-preflight.mjs";

const base = {
  invoice: {
    invoice_number: "INV-001",
    vendor: "Registered Vendor",
    amount: 25,
    currency: "USDC",
    due_date: "2026-10-08",
    decision: "PAY_NOW",
    settlement_status: null
  },
  business: {
    wallet_id: "wallet-1",
    wallet_address: "0x1111111111111111111111111111111111111111",
    wallet_status: "ready",
    policy_contract_address: "0x2222222222222222222222222222222222222222",
    policy_contract_status: "ready"
  },
  policy: { max_transaction_usdc: 1000, daily_limit_usdc: 5000, cash_floor_usdc: 20, paused: false },
  vendor: { name: "Registered Vendor", status: "verified", recipient_address: "0x3333333333333333333333333333333333333333" },
  onchainPolicy: { max_transaction_usdc: 1000, daily_limit_usdc: 5000, cash_floor_usdc: 20, paused: false },
  policyAllowance: true,
  onchain: {
    vendorRegistered: true,
    vendorStatus: "Registered",
    walletBalance: 100,
    currentDaySpent: 0,
    canExecute: { checked: true, allowed: true, reason: "ALLOWED" }
  }
};

assert.equal(buildPaymentPreflight(base).eligible, true);
assert.match(buildPaymentPreflight({ ...base, invoice: { ...base.invoice, currency: "USD" } }).reasons.join(" "), /USDC/);
assert.match(buildPaymentPreflight({ ...base, vendor: { ...base.vendor, status: "review" } }).reasons.join(" "), /verified/);
assert.match(buildPaymentPreflight({ ...base, policyAllowance: false }).reasons.join(" "), /authorize/);
assert.match(buildPaymentPreflight({ ...base, onchainPolicy: { ...base.onchainPolicy, paused: true } }).reasons.join(" "), /paused/i);
assert.match(buildPaymentPreflight({ ...base, invoice: { ...base.invoice, amount: 1001 } }).reasons.join(" "), /maximum/);
assert.match(buildPaymentPreflight({ ...base, onchain: { ...base.onchain, currentDaySpent: 4990 } }).reasons.join(" "), /daily/);
assert.match(buildPaymentPreflight({ ...base, onchain: { ...base.onchain, walletBalance: 30 } }).reasons.join(" "), /cash-floor/);
assert.match(buildPaymentPreflight({ ...base, onchain: { ...base.onchain, canExecute: { checked: true, allowed: false, reason: "DUPLICATE_PAYMENT" } } }).reasons.join(" "), /DUPLICATE_PAYMENT/);
assert.equal(buildPaymentPreflight({ ...base, invoice: { ...base.invoice, settlement_status: "confirmed" } }).eligible, false);
assert.match(buildPaymentPreflight({ ...base, invoice: { ...base.invoice, settlement_status: "scheduled" } }).reasons.join(" "), /queued for review/);

console.log("payment preflight checks passed");
