import assert from "node:assert/strict";
import {
  circleStateDisposition
} from "../lib/policy-sync.mjs";
import {
  classifyArcReceipt,
  matchesPaymentExecutedEvent,
  paymentIdempotencyKey,
  paymentRetryAllowed
} from "../lib/business-payment.mjs";

const expected = {
  paymentId: "0x" + "11".repeat(32),
  vendorId: "0x" + "22".repeat(32),
  recipient: "0x" + "33".repeat(20),
  amount: 500000n,
  invoiceHash: "0x" + "44".repeat(32)
};

assert.equal(paymentIdempotencyKey("business-a", expected.paymentId, 1), paymentIdempotencyKey("business-a", expected.paymentId, 1));
assert.notEqual(paymentIdempotencyKey("business-a", expected.paymentId, 1), paymentIdempotencyKey("business-a", expected.paymentId, 2));
assert.notEqual(paymentIdempotencyKey("business-a", expected.paymentId, 1), paymentIdempotencyKey("business-b", expected.paymentId, 1));
assert.equal(paymentRetryAllowed(0), true);
assert.equal(paymentRetryAllowed(4), true);
assert.equal(paymentRetryAllowed(5), false);
assert.equal(paymentRetryAllowed(-1), false);

assert.deepEqual(circleStateDisposition("INITIATED"), { terminal: false, processing: true });
assert.deepEqual(circleStateDisposition("COMPLETE"), { terminal: false, processing: false });
assert.deepEqual(circleStateDisposition("FAILED"), { terminal: true, processing: false });
assert.deepEqual(circleStateDisposition("STUCK"), { terminal: true, processing: false });
assert.deepEqual(circleStateDisposition("unknown-provider-state"), { terminal: false, processing: true });

assert.equal(matchesPaymentExecutedEvent(expected, expected), true);
assert.equal(matchesPaymentExecutedEvent({ ...expected, recipient: "0x" + "55".repeat(20) }, expected), false);
assert.equal(matchesPaymentExecutedEvent({ ...expected, amount: 500001n }, expected), false);
assert.equal(matchesPaymentExecutedEvent({ ...expected, invoiceHash: "0x" + "66".repeat(32) }, expected), false);
assert.equal(classifyArcReceipt({
  receipt: null,
  transactionTo: "0x" + "aa".repeat(20),
  expectedPolicyVault: "0x" + "aa".repeat(20),
  usedPayment: true,
  paymentEventMatches: true
}), "processing");
assert.equal(classifyArcReceipt({
  receipt: { status: "reverted" },
  transactionTo: "0x" + "aa".repeat(20),
  expectedPolicyVault: "0x" + "aa".repeat(20),
  usedPayment: false,
  paymentEventMatches: false
}), "failed");
assert.equal(classifyArcReceipt({
  receipt: { status: "success" },
  transactionTo: "0x" + "bb".repeat(20),
  expectedPolicyVault: "0x" + "aa".repeat(20),
  usedPayment: true,
  paymentEventMatches: true
}), "review");
assert.equal(classifyArcReceipt({
  receipt: { status: "success" },
  transactionTo: "0x" + "aa".repeat(20),
  expectedPolicyVault: "0x" + "aa".repeat(20),
  usedPayment: true,
  paymentEventMatches: false
}), "review");
assert.equal(classifyArcReceipt({
  receipt: { status: "success" },
  transactionTo: "0x" + "aa".repeat(20),
  expectedPolicyVault: "0x" + "aa".repeat(20),
  usedPayment: true,
  paymentEventMatches: true
}), "confirmed");

console.log("settlement recovery adversarial checks passed");
