import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "../lib/secure-tokens.mjs";

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalError = console.error;
process.env.VERCEL_ENV = "production";
delete process.env.INBOXPAY_PREVIEW_READ_ONLY;
process.env.SUPABASE_PUBLISHABLE_KEY = "test-public-config";
process.env.GMAIL_CLIENT_ID = "test-client-id";
process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
delete process.env.GMAIL_OAUTH_ALLOWED_ORIGINS;
const { default: start } = await import("../api/gmail/start.mjs");
const { default: callback } = await import("../api/gmail/callback.mjs");
const canonical = "https://inboxpay.vercel.app";
const legacy = "https://tameion-ap-agent-live.vercel.app";
let calls = [];
let integrationRows = [], rejectSave = false, omitRefresh = false;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const path = new URL(url).pathname;
  let body;
  if (path === "/auth/v1/user") body = { id: "owner-fixture" };
  else if (path === "/token") body = { access_token: "fixture-access", ...(omitRefresh ? {} : {refresh_token: "fixture-refresh"}), expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly" };
  else if (path === "/oauth2/v3/userinfo") body = { sub: "fixture-google-owner" };
  else if (path.endsWith("/businesses")) body = [{ id: "business-fixture" }];
  else if (path.endsWith("/integrations")) body = options.method === "PATCH" ? (rejectSave ? [] : integrationRows) : integrationRows;
  else throw new Error("Unexpected provider call: " + path);
  return new Response(JSON.stringify(body), { status: 200 });
};
function response() {
  return { code: 200, headers: {}, status(code) { this.code = code; return this; },
    setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = body; return this; },
    redirect(code, location) { this.code = code; this.location = location; return this; } };
}
function stateCookie(session) { return "inboxpay_google_oauth=" + encryptSecret(JSON.stringify(session)); }
async function finish(host, cookie, state) {
  const res = response();
  await callback({ method: "GET", headers: { host, cookie }, query: { state, code: "fixture-code" } }, res);
  return res;
}
try {
  console.error = () => {}; // expected rejected callbacks must not dump encrypted test state
  for (const origin of [canonical, legacy]) {
    const host = new URL(origin).host;
    const res = response();
    await start({ method: "GET", headers: { host, authorization: "Bearer fixture-owner-session", "x-forwarded-host": "attacker.invalid" } }, res);
    assert.equal(res.code, 200);
    const auth = new URL(res.body.url);
    assert.equal(auth.searchParams.get("redirect_uri"), origin + "/api/gmail/callback", "consent must return to the cookie's own origin");
    assert.equal(auth.searchParams.get("scope"), "openid email profile https://www.googleapis.com/auth/gmail.readonly");
    const cookie = res.headers["Set-Cookie"].split(";")[0];
    assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax/);
    assert.doesNotMatch(res.headers["Set-Cookie"], /Domain=/i, "OAuth state stays host-only");
    const session = JSON.parse(decryptSecret(cookie.split("=")[1]));
    assert.equal(session.redirectUri, auth.searchParams.get("redirect_uri"));
    calls = [];
    const done = await finish(host, cookie, session.state);
    assert.equal(done.location, "/?gmail=connected");
    const exchange = calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
    assert.equal(exchange.options.body.get("redirect_uri"), session.redirectUri);
    assert.equal(calls.filter((call) => call.options.method === "POST" && call.url.includes("/integrations")).length, 1);
  }
  for (const host of ["attacker.invalid", "inboxpay.vercel.app.attacker.invalid", "inboxpay.vercel.app:443", "inboxpay.vercel.app,attacker.invalid", undefined]) {
    calls = [];
    const res = response();
    await start({ method: "GET", headers: { host, authorization: "Bearer fixture-owner-session", "x-forwarded-host": "inboxpay.vercel.app" } }, res);
    assert.notEqual(res.code, 200);
    assert.equal(calls.length, 0, "untrusted host must fail before authentication/provider access");
  }
  const base = { state: "fixture-state", userToken: "fixture-owner-session", expiresAt: Date.now() + 60000, clientId: process.env.GMAIL_CLIENT_ID, redirectUri: canonical + "/api/gmail/callback" };
  integrationRows = [{ id: "integration-fixture", status: "revoked", updated_at: "2026-10-22T04:00:00Z" }];
  calls = [];
  const stale = await finish("inboxpay.vercel.app", stateCookie({ ...base, integrationVersion: { id: "integration-fixture", updatedAt: "2026-10-22T03:00:00Z" } }), base.state);
  assert.match(stale.location, /gmail=error/);
  assert.ok(!calls.some(c => c.url.includes("/integrations") && ["POST", "PATCH"].includes(c.options.method)), "older consent cannot undo disconnect");
  const newConsent = await finish("inboxpay.vercel.app", stateCookie({ ...base, integrationVersion: { id: "integration-fixture", updatedAt: integrationRows[0].updated_at } }), base.state);
  assert.equal(newConsent.location, "/?gmail=connected", "fresh consent after disconnect can reconnect");
  rejectSave = true; calls = [];
  const racing = await finish("inboxpay.vercel.app", stateCookie({ ...base, integrationVersion: { id: "integration-fixture", updatedAt: integrationRows[0].updated_at } }), base.state);
  assert.match(racing.location, /gmail=error/, "callback CAS failure must not report connected");
  assert.match(calls.find(c => c.options.method === "PATCH").url, /updated_at=eq\./);
  integrationRows = []; rejectSave = false;
  omitRefresh = true;
  integrationRows = [{id:"integration-fixture",provider_account_id:"different-google-account",refresh_token_encrypted:encryptSecret("different-mailbox-token"),status:"connected",updated_at:"2026-10-22T04:00:00Z"}];
  calls = [];
  const switchedWithoutRefresh = await finish("inboxpay.vercel.app",stateCookie({...base,integrationVersion:{id:"integration-fixture",updatedAt:integrationRows[0].updated_at}}),base.state);
  assert.match(switchedWithoutRefresh.location,/gmail=error/,"must not reuse another Google account's refresh token");
  assert.ok(!calls.some(c=>c.url.includes('/integrations') && ['POST','PATCH'].includes(c.options.method)));
  integrationRows[0].provider_account_id = "fixture-google-owner";
  const sameAccountRefresh = await finish("inboxpay.vercel.app",stateCookie({...base,integrationVersion:{id:"integration-fixture",updatedAt:integrationRows[0].updated_at}}),base.state);
  assert.equal(sameAccountRefresh.location,"/?gmail=connected","same-account stored refresh token may be preserved");
  integrationRows=[];
  assert.match((await finish("inboxpay.vercel.app",stateCookie({...base,integrationVersion:null}),base.state)).location,/gmail=error/,"new connection needs a refresh token");
  omitRefresh=false;
  for (const [host, session, state] of [
    ["tameion-ap-agent-live.vercel.app", base, base.state],
    ["inboxpay.vercel.app", { ...base, redirectUri: "https://attacker.invalid/api/gmail/callback" }, base.state],
    ["inboxpay.vercel.app", { ...base, expiresAt: Date.now() - 1 }, base.state],
    ["inboxpay.vercel.app", { ...base, expiresAt: "invalid" }, base.state],
    ["inboxpay.vercel.app", { ...base, clientId: "different-client" }, base.state],
    ["inboxpay.vercel.app", base, "wrong-state"]
  ]) {
    calls = [];
    const res = await finish(host, stateCookie(session), state);
    assert.match(res.location, /^\/\?gmail=error/);
    assert.equal(calls.length, 0, "rejected callback must not exchange code or persist integration");
  }
  // Cookies minted by the previous release are valid only on its fixed legacy callback.
  const old = { ...base }; delete old.redirectUri; delete old.clientId;
  calls = [];
  assert.equal((await finish("tameion-ap-agent-live.vercel.app", stateCookie(old), old.state)).location, "/?gmail=connected");
  calls = [];
  assert.match((await finish("inboxpay.vercel.app", stateCookie(old), old.state)).location, /^\/\?gmail=error/);
  assert.equal(calls.length, 0);
  process.env.GMAIL_OAUTH_ALLOWED_ORIGINS = "https://example-business.invalid";
  const custom = response();
  await start({ method: "GET", headers: { host: "example-business.invalid", authorization: "Bearer fixture-owner-session" } }, custom);
  assert.equal(new URL(custom.body.url).searchParams.get("redirect_uri"), "https://example-business.invalid/api/gmail/callback");
  for (const config of ["https://example-business.invalid/path", "http://example-business.invalid", "https://*.example-business.invalid", "https://user@example-business.invalid", "https://example-business.invalid?next=x", ""]) {
    process.env.GMAIL_OAUTH_ALLOWED_ORIGINS = config;
    const invalidConfig = response(); calls = [];
    await start({ method: "GET", headers: { host: "example-business.invalid", authorization: "Bearer fixture-owner-session" } }, invalidConfig);
    assert.notEqual(invalidConfig.code, 200); assert.equal(calls.length, 0);
  }
  delete process.env.GMAIL_OAUTH_ALLOWED_ORIGINS;
  for (const cookie of ["", "inboxpay_google_oauth=malformed", stateCookie(base).slice(0, -5) + "wrong"]) {
    calls = [];
    assert.match((await finish("inboxpay.vercel.app", cookie, base.state)).location, /^\/\?gmail=error/);
    assert.equal(calls.length, 0);
  }
  console.log("Gmail same-origin consent/code exchange and hostile-origin rejection passed");
} finally {
  globalThis.fetch = originalFetch; console.error = originalError;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
