import { sanitizeOperationsError, withTimeout } from "./operations-health.mjs";
import { supabaseRest } from "./supabase-server.mjs";

export const OPERATIONS_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function unhealthy(status) {
  return status === "attention" || status === "degraded";
}

function severityFor(status) {
  return status === "degraded" ? "critical" : status === "attention" ? "warning" : "info";
}

function failureThreshold(service) {
  if (/not connected|not provisioned/i.test(String(service.detail || ""))) return Infinity;
  return service.key === "reconciliation" && service.status === "attention" ? 1 : 2;
}

export function nextOperationsServiceState(existing, service, checkedAt = new Date().toISOString()) {
  const wasUnhealthy = unhealthy(existing?.status);
  const isUnhealthy = unhealthy(service.status);
  const consecutiveFailures = isUnhealthy ? Number(existing?.consecutive_failures || 0) + 1 : 0;
  const transitioned = Boolean(existing) && existing.status !== service.status;
  const firstFailedAt = isUnhealthy
    ? (wasUnhealthy ? existing.first_failed_at || checkedAt : checkedAt)
    : null;
  const lastNotifiedAt = existing?.last_notified_at || null;
  const lastNotificationAge = lastNotifiedAt ? Date.parse(checkedAt) - Date.parse(lastNotifiedAt) : Infinity;
  const notifyFailure = isUnhealthy && consecutiveFailures >= failureThreshold(service) && (
    !lastNotifiedAt || !wasUnhealthy || transitioned || lastNotificationAge >= ALERT_COOLDOWN_MS
  );
  const notifyRecovery = !isUnhealthy && wasUnhealthy && Boolean(lastNotifiedAt);

  return {
    status: service.status,
    severity: severityFor(service.status),
    detail: service.detail,
    action: service.action,
    consecutive_failures: consecutiveFailures,
    first_failed_at: firstFailedAt,
    last_failed_at: isUnhealthy ? checkedAt : existing?.last_failed_at || null,
    last_checked_at: checkedAt,
    last_transition_at: !existing || transitioned ? checkedAt : existing.last_transition_at || checkedAt,
    notification_error: null,
    updated_at: checkedAt,
    notification: notifyRecovery ? "recovered" : notifyFailure ? "failure" : null
  };
}

async function deliverAlert(payload) {
  const url = process.env.OPERATIONS_ALERT_WEBHOOK_URL;
  if (!url) return { configured: false, delivered: false };
  const secret = process.env.OPERATIONS_ALERT_WEBHOOK_SECRET;
  const response = await withTimeout(fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: "Bearer " + secret } : {})
    },
    body: JSON.stringify(payload)
  }), 8000, "Operations alert webhook");
  if (!response.ok) throw new Error("Operations alert webhook returned " + response.status);
  return { configured: true, delivered: true };
}

export async function sendOperationsSystemAlert({ service, detail, action, incidentKey, checkedAt = new Date().toISOString() }) {
  return deliverAlert({
    product: "InboxPay",
    event: "service_attention",
    incidentKey,
    status: "degraded",
    severity: "critical",
    service: { key: service, label: service === "supabase" ? "Supabase" : service },
    detail,
    action,
    checkedAt
  });
}

export async function persistOperationsHealth(token, business, userId, health) {
  const network = business.wallet_blockchain;
  const existingRows = await supabaseRest(
    "operations_service_states?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&network=eq." + encodeURIComponent(network), { token }
  ) || [];
  const existingByService = new Map(existingRows.map((row) => [row.service, row]));
  const results = [];

  for (const service of health.services || []) {
    const existing = existingByService.get(service.key);
    const next = nextOperationsServiceState(existing, service, health.checkedAt);
    const { notification, ...state } = next;
    const identity = { business_id: business.id, user_id: userId, network, service: service.key };
    let row;
    if (existing) {
      const rows = await supabaseRest(
        "operations_service_states?id=eq." + encodeURIComponent(existing.id),
        { token, method: "PATCH", body: state }
      );
      row = rows?.[0];
    } else {
      const rows = await supabaseRest("operations_service_states", {
        token, method: "POST", body: { ...identity, ...state }
      });
      row = rows?.[0];
    }

    if (notification && row) {
      const previousNotifiedAt = row.last_notified_at || null;
      const claimedAt = new Date().toISOString();
      const claimRows = await supabaseRest(
        "operations_service_states?id=eq." + encodeURIComponent(row.id) +
          (previousNotifiedAt
            ? "&last_notified_at=eq." + encodeURIComponent(previousNotifiedAt)
            : "&last_notified_at=is.null"),
        { token, method: "PATCH", body: { last_notified_at: claimedAt, notification_error: null, updated_at: claimedAt } }
      );
      if (!claimRows?.[0]) {
        results.push({ service: service.key, status: service.status, notification: null });
        continue;
      }
      try {
        const delivery = await deliverAlert({
          product: "InboxPay",
          event: notification === "recovered" ? "service_recovered" : "service_attention",
          incidentKey: [business.id, network, service.key].join(":"),
          business: { id: business.id, name: business.name },
          network,
          service: { key: service.key, label: service.label },
          status: service.status,
          severity: state.severity,
          detail: service.detail,
          action: service.action,
          checkedAt: health.checkedAt
        });
        if (!delivery.configured) {
          await supabaseRest(
            "operations_service_states?id=eq." + encodeURIComponent(row.id) + "&last_notified_at=eq." + encodeURIComponent(claimedAt),
            { token, method: "PATCH", body: { last_notified_at: previousNotifiedAt, updated_at: new Date().toISOString() } }
          );
        }
      } catch (error) {
        await supabaseRest(
          "operations_service_states?id=eq." + encodeURIComponent(row.id) + "&last_notified_at=eq." + encodeURIComponent(claimedAt), {
          token,
          method: "PATCH",
          body: {
            last_notified_at: previousNotifiedAt,
            notification_error: sanitizeOperationsError(error),
            updated_at: new Date().toISOString()
          }
        }).catch(() => {});
      }
    }
    results.push({ service: service.key, status: service.status, notification });
  }
  return results;
}
