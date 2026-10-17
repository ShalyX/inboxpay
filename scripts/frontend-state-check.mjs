import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activateDestination,
  auditEventCategory,
  auditEventLabel,
  destinationFromHash,
  inboxFailurePresentation,
  invoiceQueueCategory,
  networkLabel,
  operationsStatusPresentation,
  paymentFlowStep,
  singleFlight
} from "../public/ui-state.mjs";

assert.equal(destinationFromHash("#payments"), "payments");
assert.equal(destinationFromHash("#/vendors"), "vendors");
assert.equal(destinationFromHash("#unknown"), "inbox");
assert.equal(destinationFromHash("#operations"), "operations");
assert.equal(destinationFromHash(""), "inbox");
assert.equal(auditEventLabel("payment_settled"), "Payment settled and reconciled");
assert.equal(auditEventLabel("custom_business_event"), "Custom business event");
assert.equal(auditEventCategory("payment_submitted"), "payments");
assert.equal(auditEventCategory("policy_allowance_approved"), "policy");
assert.equal(auditEventCategory("vendor_registered"), "vendors");
assert.equal(auditEventCategory("invoice_schedule_rescheduled"), "schedule");
assert.equal(auditEventLabel("payment_autonomy_enabled"), "Bounded payment autonomy enabled");
assert.equal(auditEventLabel("invoice_ingestion_review_required"), "Invoice attachment needs extraction review");
assert.equal(auditEventCategory("invoice_autonomy_completed"), "payments");
assert.equal(auditEventCategory("wallet_withdrawal_confirmed"), "payments");

function fakeElement(nav) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: nav ? { nav } : {},
    hidden: true,
    inert: false,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, active) => active ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name)
  };
}

const activitySection = fakeElement();
const sections = {
  inbox: null,
  payments: activitySection,
  policy: fakeElement(),
  audit: activitySection,
  operations: activitySection,
  business: fakeElement(),
  vendors: fakeElement()
};
const navItems = Object.keys(sections).map(fakeElement);
const inboxContent = fakeElement();
for (const destination of Object.keys(sections)) {
  activateDestination(destination, sections, navItems, inboxContent);
  assert.deepEqual(
    [...new Set(Object.values(sections))].filter((section) => section && !section.hidden),
    sections[destination] ? [sections[destination]] : [],
    `${destination} must be the only visible destination`
  );
  assert.equal(inboxContent.inert, destination !== "inbox");
  assert.deepEqual(navItems.filter((item) => item.classList.contains("active")).map((item) => item.dataset.nav), [destination]);
  assert.deepEqual(navItems.filter((item) => item.getAttribute("aria-current") === "page").map((item) => item.dataset.nav), [destination]);
}
assert.throws(() => activateDestination("missing", sections, navItems), /Unknown workspace destination/);

assert.equal(networkLabel("ARC"), "Arc Mainnet");
assert.equal(networkLabel("ARC-TESTNET"), "Arc Testnet");
assert.equal(networkLabel("UNKNOWN"), "Arc");

assert.deepEqual(operationsStatusPresentation("healthy"), { label: "Healthy", tone: "ready" });
assert.deepEqual(operationsStatusPresentation("recovering"), { label: "Recovering", tone: "recovering" });
assert.deepEqual(operationsStatusPresentation("attention"), { label: "Needs attention", tone: "attention" });
assert.deepEqual(operationsStatusPresentation("degraded"), { label: "Unavailable", tone: "degraded" });

assert.equal(paymentFlowStep({}), 0);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" } }), 1);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflightLoading: true }), 2);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflight: { eligible: true } }), 3);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "processing" } } }), 4);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "confirmed" } } }), 4);

assert.equal(invoiceQueueCategory({ settlement: { status: "confirmed" } }, false), "settled");
assert.equal(invoiceQueueCategory({ settlement: { reconciled: true } }, false), "settled");
assert.equal(invoiceQueueCategory({ invoiceNumber: "INV-1" }, true), "ready");
assert.equal(invoiceQueueCategory({ invoiceNumber: "INV-1" }, false), "review");

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

const [indexHtml, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8")
]);
assert.match(indexHtml, /id="skip-link" class="skip-link" href="#main-content" hidden/);
assert.match(indexHtml, /id="main-content" class="content" tabindex="-1"/);
assert.match(styles, /@media\(max-width:1180px\) and \(min-width:801px\)[\s\S]*?\.nav-groups nav\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
assert.match(styles, /@media\(max-width:1180px\) and \(min-width:801px\)[\s\S]*?\.workspace\{grid-template-columns:minmax\(0,1fr\)\}/);

console.log("frontend state checks passed");
