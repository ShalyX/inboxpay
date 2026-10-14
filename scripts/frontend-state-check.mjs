import assert from "node:assert/strict";
import {
  inboxFailurePresentation,
  networkLabel,
  paymentFlowStep,
  singleFlight
} from "../public/ui-state.mjs";

assert.equal(networkLabel("ARC"), "Arc Mainnet");
assert.equal(networkLabel("ARC-TESTNET"), "Arc Testnet");
assert.equal(networkLabel("UNKNOWN"), "Arc");

assert.equal(paymentFlowStep({}), 0);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" } }), 1);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflightLoading: true }), 2);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflight: { eligible: true } }), 3);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "processing" } } }), 4);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "confirmed" } } }), 4);

const configFailure = inboxFailurePresentation("INBOXPAY_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key");
assert.equal(configFailure.kind, "service");
assert.equal(configFailure.title, "Live inbox temporarily unavailable");
assert.doesNotMatch(configFailure.message, /INBOXPAY_TOKEN_ENCRYPTION_KEY|32-byte|hex key/i);
assert.equal(configFailure.actionLabel, "Retry inbox evaluation");

const revoked = inboxFailurePresentation("invalid_grant: Token has been expired or revoked");
assert.equal(revoked.kind, "reauthorization");
assert.equal(revoked.title, "Reconnect your business inbox");
assert.equal(revoked.actionLabel, "Reconnect Gmail");

const ordinaryFailure = inboxFailurePresentation("Gmail request timed out");
assert.equal(ordinaryFailure.kind, "service");
assert.equal(ordinaryFailure.title, "Live inbox temporarily unavailable");
assert.doesNotMatch(ordinaryFailure.message, /timed out/i);

let releaseConnection;
let connectionStarts = 0;
const connectOnce = singleFlight(() => {
  connectionStarts += 1;
  return new Promise((resolve) => {
    releaseConnection = resolve;
  });
});
const firstConnection = connectOnce();
const repeatedConnection = connectOnce();
assert.strictEqual(repeatedConnection, firstConnection);
assert.equal(connectionStarts, 1);
releaseConnection();
await firstConnection;
const nextConnection = connectOnce();
assert.equal(connectionStarts, 2);
releaseConnection();
await nextConnection;

console.log("frontend state checks passed");
