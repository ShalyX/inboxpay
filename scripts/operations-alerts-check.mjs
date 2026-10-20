import assert from "node:assert/strict";
import {
  formatTelegramAlert,
  isOperationsAlertDeliveryConfigured,
  nextOperationsServiceState,
  persistOperationsHealth
} from "../lib/operations-alerts.mjs";

const firstFailure = nextOperationsServiceState(null, {
  key: "circle", status: "degraded", detail: "Service check failed", action: "Retry"
}, "2026-10-17T20:00:00.000Z");
assert.equal(firstFailure.consecutive_failures, 1);
assert.equal(firstFailure.notification, null, "A transient provider failure must not page immediately");

const secondFailure = nextOperationsServiceState({ ...firstFailure, last_notified_at: null }, {
  key: "circle", status: "degraded", detail: "Service check failed", action: "Retry"
}, "2026-10-17T20:05:00.000Z");
assert.equal(secondFailure.consecutive_failures, 2);
assert.equal(secondFailure.notification, "failure");

const steadyFailure = nextOperationsServiceState({
  ...secondFailure,
  last_notified_at: "2026-10-17T20:05:01.000Z"
}, {
  key: "circle", status: "degraded", detail: "Service check failed", action: "Retry"
}, "2026-10-17T20:10:00.000Z");
assert.equal(steadyFailure.notification, null, "Alert cooldown must suppress duplicate pages");

const recovery = nextOperationsServiceState({
  ...steadyFailure,
  status: "degraded",
  last_notified_at: "2026-10-17T20:05:01.000Z"
}, {
  key: "circle", status: "healthy", detail: "Reachable", action: "No action required"
}, "2026-10-17T20:15:00.000Z");
assert.equal(recovery.notification, "recovered");
assert.equal(recovery.consecutive_failures, 0);
assert.equal(recovery.first_failed_at, null);

const reconciliationHold = nextOperationsServiceState(null, {
  key: "reconciliation", status: "attention", detail: "One record needs review", action: "Review"
}, "2026-10-17T20:20:00.000Z");
assert.equal(reconciliationHold.notification, "failure", "A stopped financial reconciliation must surface immediately");

const incompleteSetup = nextOperationsServiceState({ status: "attention", consecutive_failures: 1 }, {
  key: "circle", status: "attention", detail: "Dedicated business wallet is not provisioned", action: "Provision wallet"
}, "2026-10-17T20:25:00.000Z");
assert.equal(incompleteSetup.notification, null, "Expected onboarding gaps stay visible without paging as outages");

assert.equal(isOperationsAlertDeliveryConfigured({}), false);
assert.equal(isOperationsAlertDeliveryConfigured({ TELEGRAM_BOT_TOKEN: "token" }), false);
assert.equal(isOperationsAlertDeliveryConfigured({
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_ALERT_CHAT_ID: "123"
}), true);
assert.equal(isOperationsAlertDeliveryConfigured({ OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example" }), true);

const telegramMessage = formatTelegramAlert({
  event: "service_attention",
  incidentKey: "business:ARC-TESTNET:circle",
  business: { name: "Caraxes Labs" },
  network: "ARC-TESTNET",
  service: { key: "circle", label: "Circle" },
  severity: "critical",
  detail: "Dedicated wallet is unavailable",
  action: "Preserve transaction IDs and inspect Circle",
  checkedAt: "2026-10-18T15:00:00.000Z"
});
assert.match(telegramMessage, /InboxPay operations alert/);
assert.match(telegramMessage, /InboxPay operations alert\nService: Circle/);
assert.match(telegramMessage, /Caraxes Labs/);
assert.match(telegramMessage, /Preserve transaction IDs/);

process.env.SUPABASE_PUBLISHABLE_KEY = "operations-test-publishable-key";
process.env.TELEGRAM_BOT_TOKEN = "operations-test-bot-token";
process.env.TELEGRAM_ALERT_CHAT_ID = "operator-chat";
const originalFetch = globalThis.fetch;
let storedState = null;
const operatorDeliveries = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes("api.telegram.org")) {
    operatorDeliveries.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (!String(url).includes("/rest/v1/operations_service_states")) throw new Error("Unexpected operations request");
  const method = options.method || "GET";
  if (method === "GET") return new Response(JSON.stringify(storedState ? [storedState] : []), { status: 200 });
  const body = JSON.parse(options.body);
  storedState = { ...storedState, ...body, id: "state-1" };
  return new Response(JSON.stringify([storedState]), { status: 200 });
};
try {
  const business = { id: "business-a", name: "Caraxes Labs", wallet_blockchain: "ARC-TESTNET" };
  const service = { key: "circle", label: "Circle", status: "degraded", detail: "Circle is unavailable", action: "Inspect Circle" };
  await persistOperationsHealth("user-token", business, "user-a", {
    checkedAt: "2026-10-19T10:00:00.000Z", services: [service]
  });
  assert.equal(operatorDeliveries.length, 0, "First transient failure must not page");
  await persistOperationsHealth("user-token", business, "user-a", {
    checkedAt: "2026-10-19T10:05:00.000Z", services: [service]
  });
  assert.equal(operatorDeliveries.length, 1);
  assert.equal(operatorDeliveries[0].chat_id, "operator-chat", "A business incident must use the operator destination");
  assert.match(operatorDeliveries[0].text, /Business: Caraxes Labs/);
  assert.match(operatorDeliveries[0].text, /Service: Circle/);
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
}

console.log("Operations alert transition gate passed");
