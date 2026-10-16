import assert from "node:assert/strict";
import {
  buildOperationsHealth,
  operationRecoveryItems,
  sanitizeOperationsError,
  withTimeout
} from "../lib/operations-health.mjs";

const checkedAt = "2026-10-16T20:00:00.000Z";

assert.equal(
  sanitizeOperationsError("Bearer sb_secret_abc123 failed with api_key=super-secret"),
  "Service check failed"
);
assert.equal(sanitizeOperationsError("Gmail request timed out"), "Service check timed out");
assert.equal(sanitizeOperationsError("Google OAuth refresh failed: invalid_grant"), "Authorization needs renewal");

await assert.rejects(
  withTimeout(new Promise(() => {}), 5, "Arc RPC"),
  /Arc RPC check timed out/
);

const recoveries = operationRecoveryItems({
  jobs: [{
    id: "job-1",
    invoice_id: "invoice-1",
    status: "retry",
    attempt_count: 2,
    max_attempts: 5,
    next_attempt_at: "2026-10-16T20:02:00.000Z",
    last_error: "Circle temporary failure",
    updated_at: "2026-10-16T19:59:00.000Z"
  }],
  withdrawals: [{
    id: "withdrawal-1",
    request_id: "wd-1",
    status: "review",
    error: "Receipt requires operator review",
    updated_at: "2026-10-16T19:58:00.000Z"
  }],
  invoices: [{
    id: "invoice-2",
    invoice_number: "INV-2",
    vendor: "Acme",
    settlement_status: "processing",
    updated_at: "2026-10-16T19:30:00.000Z"
  }],
  now: Date.parse(checkedAt),
  staleAfterMs: 15 * 60 * 1000
});

assert.equal(recoveries.length, 3);
assert.equal(recoveries.find((item) => item.id === "job-1").state, "recovering");
assert.equal(recoveries.find((item) => item.id === "withdrawal-1").state, "attention");
assert.equal(recoveries.find((item) => item.id === "invoice-2").state, "attention");
assert.match(recoveries.find((item) => item.id === "job-1").detail, /attempt 2 of 5/i);

const deduplicated = operationRecoveryItems({
  jobs: [{ id: "job-2", invoice_id: "invoice-3", status: "reconciling", updated_at: checkedAt }],
  invoices: [{ id: "invoice-3", invoice_number: "INV-3", settlement_status: "processing", updated_at: checkedAt }],
  now: Date.parse(checkedAt)
});
assert.equal(deduplicated.length, 1);
assert.equal(deduplicated[0].id, "job-2");

const futureQueue = operationRecoveryItems({
  jobs: [{ id: "future-job", status: "queued", scheduled_for: "2026-10-17T20:00:00.000Z", updated_at: checkedAt }],
  now: Date.parse(checkedAt)
});
assert.equal(futureQueue.length, 0);

const healthy = buildOperationsHealth({
  checkedAt,
  services: [
    { key: "gmail", label: "Gmail", status: "healthy", detail: "Connected" },
    { key: "circle", label: "Circle", status: "healthy", detail: "Wallet reachable" },
    { key: "arc", label: "Arc RPC", status: "healthy", detail: "Chain verified" },
    { key: "supabase", label: "Supabase", status: "healthy", detail: "Business data reachable" },
    { key: "reconciliation", label: "Reconciliation", status: "healthy", detail: "No unresolved records" }
  ],
  recoveries: []
});
assert.equal(healthy.overall, "healthy");
assert.equal(healthy.summary.healthyServices, 5);
assert.equal(healthy.summary.attentionCount, 0);

const degraded = buildOperationsHealth({
  checkedAt,
  services: [
    { key: "gmail", label: "Gmail", status: "degraded", detail: "Service check failed" },
    { key: "circle", label: "Circle", status: "healthy", detail: "Wallet reachable" }
  ],
  recoveries
});
assert.equal(degraded.overall, "degraded");
assert.equal(degraded.summary.degradedServices, 1);
assert.equal(degraded.summary.recoveringCount, 1);
assert.equal(degraded.summary.attentionCount, 2);

console.log("operations health checks passed");
