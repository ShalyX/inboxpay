import assert from "node:assert/strict";
import { rejectPreviewRequest, isReadOnlyPreview } from "../lib/preview-boundary.mjs";
const prior = process.env.VERCEL_ENV;
const priorPublicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
process.env.SUPABASE_PUBLISHABLE_KEY = "preview-test-public-key";
process.env.VERCEL_ENV = "preview";
assert.equal(isReadOnlyPreview(), true);
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error("Blocked preview request reached a provider"); };
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} }; }
try {
  for (const route of ["pay", "policy", "vendors", "wallet", "invoices", "activity", "config", "onboarding", "gmail/start", "gmail/callback"]) {
    const { default: handler } = await import("../api/" + route + ".mjs");
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = response();
      await handler({ method, headers: {}, query: {}, body: { action: "autonomy_tick" } }, res);
      assert.equal(res.code, 403, route + " " + method + " must be disabled before provider access");
      assert.equal(res.body.code, "READ_ONLY_PREVIEW");
    }
  }
  for (const route of ["gmail/start", "gmail/callback"]) {
    const { default: handler } = await import("../api/" + route + ".mjs");
    const res = response();
    await handler({ method: "GET", headers: {}, query: {} }, res);
    assert.equal(res.code, 403, "preview cannot start or finish Gmail OAuth");
  }
  assert.equal(networkCalls, 0);
  const reads = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.method || "GET", "GET", "saved-record preview must never write or invoke an RPC");
    reads.push(String(url));
    const path = new URL(url).pathname;
    let rows;
    if (path === "/auth/v1/user") rows = { id: "owner-a" };
    else if (path.endsWith("/businesses")) rows = [{ id: "business-a", owner_user_id: "owner-a", active_network: "ARC-TESTNET", name: "Read fixture" }];
    else if (path.endsWith("/business_network_accounts")) rows = [{ business_id: "business-a", network: "ARC-TESTNET", wallet_blockchain: "ARC-TESTNET", wallet_status: "not_provisioned" }];
    else if (path.endsWith("/invoices")) {
      assert.match(String(url), /business_id=eq.business-a/);
      assert.match(String(url), /settlement_network=eq.ARC-TESTNET/);
      rows = [{ id: "invoice-a", invoice_number: "SAVED-001", vendor: "Example", amount: "1", currency: "USDC", decision: "ESCALATE", decision_reasons: [], sources: [], settlement_status: null }];
    } else if (/\/(audit_events|invoice_execution_jobs)$/.test(path)) rows = [];
    else throw new Error("Unexpected preview network access: " + path);
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const { default: invoiceHandler } = await import("../api/invoices.mjs");
  const saved = response();
  await invoiceHandler({ method: "GET", headers: { authorization: "Bearer preview-test-token" }, query: {} }, saved);
  assert.equal(saved.code, 200);
  assert.equal(saved.body.source, "saved-records-preview");
  assert.equal(saved.body.liveGmail, false);
  assert.equal(saved.body.invoices[0].invoiceNumber, "SAVED-001");
  assert.ok(reads.every((url) => new URL(url).hostname.endsWith("supabase.co")), "preview snapshot must not reach Google or Circle");
  assert.equal(rejectPreviewRequest({ method: "GET" }, response()), false);
  assert.equal(rejectPreviewRequest({ method: "POST", body: { action: "approve" } }, response(), { bootstrap: true }), false);
  assert.equal(rejectPreviewRequest({ method: "POST", body: { action: "approve", businessName: "New Name" } }, response(), { bootstrap: true }), true, "preview cannot submit identity changes");
  assert.equal(rejectPreviewRequest({ method: "POST", body: { action: "provision_wallet" } }, response(), { bootstrap: true }), true);
  process.env.VERCEL_ENV = "production";
  assert.equal(isReadOnlyPreview(), false);
  assert.equal(rejectPreviewRequest({ method: "POST" }, response()), false);
} finally {
  globalThis.fetch = originalFetch;
  if (prior === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prior;
  if (priorPublicKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = priorPublicKey;
}
console.log("Preview write boundary passed: blocked routes made zero provider calls");
