import assert from "node:assert/strict";
import {
  hashNotificationLinkToken,
  normalizeNotificationPreferences,
  notificationChannelView,
  parseTelegramStart,
  sendBusinessNotification
} from "../lib/business-notifications.mjs";
import { encryptSecret } from "../lib/secure-tokens.mjs";

const token = "0123456789abcdefghij_ABCDEFGH-123";
assert.equal(hashNotificationLinkToken(token).length, 64);
assert.equal(hashNotificationLinkToken(token), hashNotificationLinkToken(token));
assert.notEqual(hashNotificationLinkToken(token), hashNotificationLinkToken(token + "x"));
assert.equal(parseTelegramStart(`/start ${token}`), token);
assert.equal(parseTelegramStart(`/start@InboxPayBot ${token}`), token);
assert.equal(parseTelegramStart("/start"), null);
assert.equal(parseTelegramStart("hello"), null);

assert.deepEqual(normalizeNotificationPreferences({}), { service_attention: true, service_recovered: true });
assert.deepEqual(normalizeNotificationPreferences({ service_attention: false, service_recovered: false }), {
  service_attention: false,
  service_recovered: false
});

const view = notificationChannelView({
  destination_encrypted: "must-never-leave-server",
  destination_hint: "Telegram chat •••1234",
  chat_type: "private",
  status: "active",
  preferences: { service_attention: true, service_recovered: false },
  linked_at: "2026-10-19T00:00:00.000Z",
  last_tested_at: null
});
assert.equal(view.status, "connected");
assert.equal(view.destinationHint, "Telegram chat •••1234");
assert.equal("destination_encrypted" in view, false);
assert.equal(view.preferences.service_recovered, false);
assert.equal(notificationChannelView(null).status, "not_connected");

process.env.SUPABASE_SECRET_KEY = "notification-test-service-secret";
process.env.TELEGRAM_BOT_TOKEN = "notification-test-bot-token";
process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
const originalFetch = globalThis.fetch;
const queries = [];
const deliveries = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("/rest/v1/business_notification_channels")) {
    queries.push(String(url));
    const businessId = new URL(String(url)).searchParams.get("business_id")?.replace(/^eq\./, "");
    const row = businessId === "business-a" ? {
      status: "active",
      destination_encrypted: encryptSecret("1111"),
      preferences: { service_attention: true, service_recovered: false }
    } : null;
    return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
  }
  if (String(url).includes("api.telegram.org")) {
    deliveries.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  throw new Error("Unexpected notification test request");
};
try {
  const absent = await sendBusinessNotification("business-b", "service_attention", "Incident B");
  assert.equal(absent.configured, false);
  assert.equal(deliveries.length, 0, "A business without a linked chat must never use another destination");

  const suppressed = await sendBusinessNotification("business-a", "service_recovered", "Recovery A");
  assert.equal(suppressed.suppressed, true);
  assert.equal(deliveries.length, 0);

  const delivered = await sendBusinessNotification("business-a", "service_attention", "Incident A");
  assert.equal(delivered.delivered, true);
  assert.deepEqual(deliveries, [{ chat_id: "1111", text: "Incident A", disable_web_page_preview: true }]);
  assert.ok(queries.some((url) => url.includes("business_id=eq.business-a")));
  assert.ok(queries.some((url) => url.includes("business_id=eq.business-b")));
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY;
}

console.log("business notification checks passed");
