import assert from "node:assert/strict";

process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.SUPABASE_SECRET_KEY = "test-server-secret";
const { dedupeInvoiceRows, persistInvoice } = await import("../lib/business-data.mjs");
const { invoicePaymentId } = await import("../lib/invoice-identity.mjs");

const settled = {
  id: "settled-row",
  user_id: "user-1",
  business_id: "business-1",
  vendor: "Acme Test Hosting",
  invoice_number: "TA-GMAIL-0001",
  due_date: "2026-10-02",
  settlement_status: "confirmed",
  payment_tx_hash: "0xsettled",
  payment_id: "payment-1",
  external_message_id: "old-message"
};
const calls = [];
let lookupRows = [settled];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (options.method === "PATCH") return new Response(JSON.stringify([{ ...settled, ...JSON.parse(options.body) }]), { status: 200 });
  if (options.method === "POST") return new Response(JSON.stringify([{ id: "new-row" }]), { status: 201 });
  return new Response(JSON.stringify(lookupRows), { status: 200 });
};

const result = await persistInvoice("session", "user-1", "business-1", "integration-1", {
  messageId: "new-reminder-message",
  vendor: "Acme Test Hosting",
  invoiceNumber: "TA-GMAIL-0001",
  amount: 0.5,
  currency: "USDC",
  dueDate: "2026-10-02",
  agentDecision: "PAY_NOW",
  decisionReasons: [],
  extraction: { confidence: "high" },
  sources: []
});

assert.equal(result.id, "settled-row");
assert.equal(result.settlement_status, "confirmed");
assert.equal(result.payment_tx_hash, "0xsettled");
assert.equal(result.payment_id, "payment-1");
assert.equal(calls.filter(({ options }) => options.method === "POST").length, 0);
assert.ok(calls.some(({ options }) => options.method === "PATCH" && options.headers.apikey === "test-server-secret"), "invoice writes must use server credentials");
assert.ok(calls.some(({ options }) => options.method === "GET" && options.headers.apikey === "test-publishable-key"), "invoice reads must retain owner credentials");
assert.ok(calls.some(({ url }) => url.includes("external_message_id=eq.new-reminder-message")), "exact unique-key lookup was not attempted");

calls.length = 0;
lookupRows = [];
await persistInvoice("session", "user-1", "business-1", "integration-1", {
  vendor: "Manny",
  invoiceNumber: "unique-test-001",
  amount: 1,
  currency: "USDC",
  dueDate: "a future date",
  agentDecision: "ESCALATE",
  decisionReasons: ["Required invoice fields are incomplete."],
  extraction: { confidence: "low" },
  sources: []
});
assert.ok(calls.some(({ url }) => url.includes("due_date=is.null")), "null due dates must use the PostgREST is.null filter");
assert.ok(!calls.some(({ url }) => url.includes("due_date=eq.%22%22") || url.includes("due_date=eq.")), "null due dates must not use an empty date equality filter");
assert.ok(calls.some(({ options }) => options.method === "POST" && options.headers.apikey === "test-server-secret"), "new invoice writes must use server credentials");

const deduped = dedupeInvoiceRows([
  { id: "fresh-reminder", vendor: "Acme Test Hosting", invoice_number: "TA-GMAIL-0001", due_date: "2026-10-02", settlement_status: null, updated_at: "2026-10-12T00:00:00Z" },
  settled
]);
assert.equal(deduped.length, 1);
assert.equal(deduped[0].settlement_status, "confirmed");

const stableIdentity = {
  business_id: "business-1",
  vendor: "Acme Test Hosting",
  invoice_number: "TA-GMAIL-0001",
  due_date: "2026-10-02"
};
assert.equal(
  invoicePaymentId({ ...stableIdentity, external_message_id: "message-a" }),
  invoicePaymentId({ ...stableIdentity, external_message_id: "message-b" }),
  "Gmail reminders must share one stable onchain payment ID"
);

console.log("invoice idempotency regression passed");
