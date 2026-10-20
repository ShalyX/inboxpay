import assert from "node:assert/strict";
import {
  hashNotificationLinkToken,
  formatBusinessPaymentNotification,
  deliverBusinessPaymentNotifications,
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
assert.equal("preferences" in view, false, "Retired operator incident rules must not appear in the business view");
assert.equal(notificationChannelView(null).status, "not_connected");

const paymentJob = {
  id: "alert-1", business_id: "business-a", user_id: "user-a", channel_id: "channel-a",
  channel_linked_at: "2026-10-19T00:00:00.000Z", lease_token: "lease-a", network: "ARC-TESTNET",
  event_type: "payment_confirmed",
  payload: { invoice_number: "INV-100", vendor: "Acme", amount_usdc: "0.130000", tx_hash: "0x" + "a".repeat(64) }
};
assert.match(formatBusinessPaymentNotification(paymentJob, "Business A"), /confirmed and reconciled/);
assert.match(formatBusinessPaymentNotification(paymentJob, "Business A"), /0\.130000 USDC/);
assert.match(formatBusinessPaymentNotification(paymentJob, "Business A"), /Alert ID: alert-1/);
assert.throws(() => formatBusinessPaymentNotification({ ...paymentJob, payload: { ...paymentJob.payload, tx_hash: null } }, "Business A"), /valid Arc transaction hash/);
assert.match(formatBusinessPaymentNotification({ ...paymentJob, event_type: "payment_submitted" }, "Business A"), /awaiting Arc reconciliation/);

process.env.SUPABASE_SECRET_KEY = "notification-test-service-secret";
process.env.TELEGRAM_BOT_TOKEN = "notification-test-bot-token";
process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
const originalFetch = globalThis.fetch;
const queries = [];
const deliveries = [];
let linkedAt = "2026-10-19T00:00:00.000Z";
let telegramAvailable = true;
const outcomes = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("/rest/v1/business_notification_channels")) {
    queries.push(String(url));
    const businessId = new URL(String(url)).searchParams.get("business_id")?.replace(/^eq\./, "");
    const row = businessId === "business-a" ? {
      id: "channel-a", business_id: "business-a", user_id: "user-a", linked_at: linkedAt,
      status: "active",
      destination_encrypted: encryptSecret("1111"),
      preferences: { service_attention: true, service_recovered: false }
    } : null;
    return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
  }
  if (String(url).includes("/rest/v1/businesses")) {
    return new Response(JSON.stringify([{ id: "business-a", owner_user_id: "user-a", name: "Business A" }]), { status: 200 });
  }
  if (String(url).includes("/rest/v1/rpc/claim_business_payment_notifications")) {
    return new Response(JSON.stringify([paymentJob]), { status: 200 });
  }
  if (String(url).includes("/rest/v1/rpc/finish_business_payment_notification")) {
    const body = JSON.parse(options.body);
    assert.equal(body.p_job_id, "alert-1");
    assert.equal(body.p_lease_token, "lease-a");
    outcomes.push(body.p_outcome);
    return new Response(JSON.stringify(true), { status: 200 });
  }
  if (String(url).includes("api.telegram.org")) {
    if (!telegramAvailable) throw new Error("Telegram unavailable");
    deliveries.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  throw new Error("Unexpected notification test request");
};
try {
  await assert.rejects(
    sendBusinessNotification("business-a", "service_attention", "Incident A"),
    /Unsupported customer notification event/,
    "Provider incidents must never use the business Telegram path"
  );
  await assert.rejects(
    sendBusinessNotification("business-a", "service_recovered", "Recovery A"),
    /Unsupported customer notification event/
  );
  const absent = await sendBusinessNotification("business-b", "connection_test", "Connection test B");
  assert.equal(absent.configured, false);
  assert.equal(deliveries.length, 0, "A business without a linked chat must never use another destination");

  const delivered = await sendBusinessNotification("business-a", "connection_test", "Connection test A");
  assert.equal(delivered.delivered, true);
  assert.deepEqual(deliveries, [{ chat_id: "1111", text: "Connection test A", disable_web_page_preview: true }]);
  assert.ok(queries.some((url) => url.includes("business_id=eq.business-a")));
  assert.ok(queries.some((url) => url.includes("business_id=eq.business-b")));
  const queueResults = await deliverBusinessPaymentNotifications("notification-test-service-secret");
  assert.deepEqual(queueResults, [{ id: "alert-1", outcome: "delivered", recorded: true }]);
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[1].text, /Business: Business A/);
  assert.match(deliveries[1].text, /confirmed and reconciled/);
  assert.ok(queries.some((url) => url.includes("id=eq.channel-a") && url.includes("user_id=eq.user-a")));
  linkedAt = "2026-10-20T00:00:00.000Z";
  assert.deepEqual(await deliverBusinessPaymentNotifications("notification-test-service-secret"), [
    { id: "alert-1", outcome: "skipped", recorded: true }
  ], "A relinked destination must not receive earlier business events");
  assert.equal(deliveries.length, 2);
  linkedAt = "2026-10-19T00:00:00.000Z";
  telegramAvailable = false;
  assert.deepEqual(await deliverBusinessPaymentNotifications("notification-test-service-secret"), [
    { id: "alert-1", outcome: "retry", recorded: true }
  ]);
  assert.deepEqual(outcomes, ["delivered", "skipped", "retry"]);
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.INBOXPAY_TOKEN_ENCRYPTION_KEY;
}

console.log("business notification checks passed");
