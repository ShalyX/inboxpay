const SENSITIVE_ERROR = /bearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+|sb_(?:secret|publishable)_\S+/i;
const AUTH_ERROR = /invalid_grant|expired or revoked|authorization.*renew|reauthor/i;
const TIMEOUT_ERROR = /timed?\s*out|timeout/i;

export function sanitizeOperationsError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (AUTH_ERROR.test(message)) return "Authorization needs renewal";
  if (TIMEOUT_ERROR.test(message)) return "Service check timed out";
  if (!message || SENSITIVE_ERROR.test(message)) return "Service check failed";
  return "Service check failed";
}

export async function withTimeout(promise, timeoutMs, label = "Service") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " check timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function recoveryDetail(kind, row, state) {
  if (kind === "payment") {
    const attempts = Number(row.attempt_count || 0);
    const maximum = Number(row.max_attempts || 0);
    if (state === "recovering") {
      return `Durable retry is scheduled · attempt ${attempts} of ${maximum || "bounded"}`;
    }
    return "Autonomous settlement stopped safely and needs operator review";
  }
  if (kind === "withdrawal") {
    return state === "recovering"
      ? "Submitted transfer is waiting for a reconciled Circle and Arc receipt"
      : "Withdrawal stopped safely and needs operator review";
  }
  return state === "recovering"
    ? "Submitted payment is waiting for a reconciled Arc receipt"
    : "Settlement has remained unresolved beyond the recovery window";
}

function isStale(row, now, staleAfterMs) {
  const updatedAt = Date.parse(String(row.updated_at || ""));
  return Number.isFinite(updatedAt) && now - updatedAt > staleAfterMs;
}

export function operationRecoveryItems({
  jobs = [],
  withdrawals = [],
  invoices = [],
  now = Date.now(),
  staleAfterMs = 15 * 60 * 1000
} = {}) {
  const items = [];
  const jobInvoiceIds = new Set(jobs.map((job) => job.invoice_id).filter(Boolean));

  for (const job of jobs) {
    const status = String(job.status || "").toLowerCase();
    const scheduledFor = Date.parse(String(job.scheduled_for || ""));
    if (status === "queued" && Number.isFinite(scheduledFor) && scheduledFor > now) continue;
    const recovering = ["queued", "leased", "retry", "reconciling"].includes(status) && !isStale(job, now, staleAfterMs);
    items.push({
      id: job.id,
      kind: "payment",
      title: job.invoice_number ? `Invoice ${job.invoice_number}` : "Autonomous payment job",
      status,
      state: recovering ? "recovering" : "attention",
      detail: recoveryDetail("payment", job, recovering ? "recovering" : "attention"),
      attempts: Number(job.attempt_count || 0),
      maxAttempts: Number(job.max_attempts || 0),
      nextAttemptAt: job.next_attempt_at || null,
      updatedAt: job.updated_at || null
    });
  }

  for (const withdrawal of withdrawals) {
    const status = String(withdrawal.status || "").toLowerCase();
    const recovering = status === "processing" && !isStale(withdrawal, now, staleAfterMs);
    items.push({
      id: withdrawal.id,
      kind: "withdrawal",
      title: withdrawal.request_id ? `Withdrawal ${withdrawal.request_id}` : "Wallet withdrawal",
      status,
      state: recovering ? "recovering" : "attention",
      detail: recoveryDetail("withdrawal", withdrawal, recovering ? "recovering" : "attention"),
      nextAttemptAt: null,
      updatedAt: withdrawal.updated_at || null
    });
  }

  for (const invoice of invoices) {
    if (jobInvoiceIds.has(invoice.id)) continue;
    const status = String(invoice.settlement_status || "").toLowerCase();
    const recovering = ["processing", "reconciling"].includes(status) && !isStale(invoice, now, staleAfterMs);
    items.push({
      id: invoice.id,
      kind: "reconciliation",
      title: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : "Invoice settlement",
      subtitle: invoice.vendor || null,
      status,
      state: recovering ? "recovering" : "attention",
      detail: recoveryDetail("reconciliation", invoice, recovering ? "recovering" : "attention"),
      nextAttemptAt: null,
      updatedAt: invoice.updated_at || null
    });
  }

  return items.sort((left, right) => {
    if (left.state !== right.state) return left.state === "attention" ? -1 : 1;
    return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
  });
}

export function buildOperationsHealth({ checkedAt = new Date().toISOString(), services = [], recoveries = [] } = {}) {
  const normalizedServices = services.map((service) => ({
    ...service,
    status: ["healthy", "recovering", "attention", "degraded"].includes(service.status)
      ? service.status
      : "degraded",
    checkedAt: service.checkedAt || checkedAt
  }));
  const summary = {
    totalServices: normalizedServices.length,
    healthyServices: normalizedServices.filter((service) => service.status === "healthy").length,
    degradedServices: normalizedServices.filter((service) => service.status === "degraded").length,
    recoveringCount: recoveries.filter((item) => item.state === "recovering").length,
    attentionCount: recoveries.filter((item) => item.state === "attention").length
  };
  const overall = summary.degradedServices > 0
    ? "degraded"
    : summary.attentionCount > 0 || normalizedServices.some((service) => service.status === "attention")
      ? "attention"
      : summary.recoveringCount > 0 || normalizedServices.some((service) => service.status === "recovering")
        ? "recovering"
        : "healthy";

  return {
    checkedAt,
    overall,
    services: normalizedServices,
    summary,
    recovery: { items: recoveries }
  };
}
