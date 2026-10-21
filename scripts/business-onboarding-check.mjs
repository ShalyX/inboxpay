import assert from "node:assert/strict";

const previous = { env: process.env.VERCEL_ENV, key: process.env.SUPABASE_PUBLISHABLE_KEY, fetch: globalThis.fetch };
process.env.VERCEL_ENV = "production";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-public-key";
let business = null;
let accounts = [];
let policies = [];
const writes = [];
const user = { id: "owner-new", email: "new-owner@gmail.com", user_metadata: { business_name: "gmail.com" } };
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.match(url.hostname, /supabase\.co$/, "onboarding must not call Gmail, Circle or Arc");
  const method = options.method || "GET";
  const table = url.pathname.split("/").at(-1);
  let data;
  if (url.pathname === "/auth/v1/user") data = user;
  else {
    assert.equal(options.headers.Authorization, "Bearer owner-token", "bootstrap uses owner RLS, not a service role");
    if (method === "POST") {
      const body = JSON.parse(options.body);
      writes.push({ table, body });
      if (table === "businesses") business = { id: "new-business", active_network: "ARC-TESTNET", ...body };
      else if (table === "business_network_accounts") accounts.push(body);
      else if (table === "policies") policies.push(body);
      else assert.fail("Unexpected bootstrap write " + table);
      data = [{ ...(table === "businesses" ? business : body) }];
    } else {
      assert.equal(method, "GET", "ordinary bootstrap cannot modify an existing business");
      if (table === "businesses") data = business ? [business] : [];
      else if (table === "business_network_accounts") data = accounts;
      else if (table === "policies") data = policies;
      else assert.fail("Unexpected bootstrap read " + table);
    }
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });
try {
  const { default: handler } = await import("../api/onboarding.mjs");
  const call = async (body) => {
    const res = response();
    await handler({ method: "POST", headers: { authorization: "Bearer owner-token" }, body, query: {} }, res);
    return res;
  };
  const unnamed = await call({ action: "approve" });
  assert.equal(unnamed.code, 200);
  assert.equal(unnamed.body.business, null, "new account must choose its own business name before creation");
  assert.equal(unnamed.body.onboarding.businessNameRequired, true);
  assert.equal(writes.length, 0, "missing name must not create business, wallet account or draft policy");
  assert.equal((await call({ action: "unknown", businessName: "Not created" })).code, 400);
  assert.equal(writes.length, 0);
  for (const businessName of ["", "x", "x".repeat(81), "Name\nInjected"]) {
    const invalid = await call({ action: "approve", businessName });
    assert.equal(invalid.code, 400);
    assert.equal(writes.length, 0);
  }
  const created = await call({ action: "approve", businessName: "  North   Studio  " });
  assert.equal(created.code, 200);
  assert.equal(created.body.business.name, "North Studio");
  assert.equal(business.owner_user_id, user.id);
  assert.equal(writes.filter((entry) => entry.table === "businesses").length, 1);
  assert.deepEqual(new Set(writes.map((entry) => entry.table)), new Set(["businesses", "business_network_accounts", "policies"]));
  const count = writes.length;
  const replay = await call({ action: "approve", businessName: "Do not rename" });
  assert.equal(replay.body.business.name, "North Studio", "sign-in never silently renames an existing business");
  assert.equal(writes.length, count, "repeated bootstrap is idempotent");
} finally {
  globalThis.fetch = previous.fetch;
  if (previous.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous.env;
  if (previous.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previous.key;
}
console.log("business identity onboarding checks passed");
