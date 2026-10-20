import crypto from "node:crypto";
import { getBusinessForNetwork } from "./businesses.mjs";
import { settleBusinessInvoice } from "./business-payment.mjs";
import { syncBusinessInvoicesForNetwork } from "./business-data.mjs";
import { getSupabaseServerSecret, supabaseRest } from "./supabase-server.mjs";
import { deliverBusinessPaymentNotifications } from "./business-notifications.mjs";
import { reconcilePendingWithdrawals } from "./wallet-withdrawals.mjs";
import { OPERATIONS_MONITOR_INTERVAL_MS, persistOperationsHealth, sendOperationsSystemAlert } from "./operations-alerts.mjs";
import { probeBusinessOperations } from "./operations-monitor.mjs";

const DEFAULT_BATCH_SIZE = 3;
const MAX_POLICIES_PER_CYCLE = 5;
const LEASE_SECONDS = 240;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const MAX_MONITORED_BUSINESSES_PER_CYCLE = 5;

async function runOperationalMonitoring(token, now = new Date()) {
  const allBusinesses = await supabaseRest(
    "businesses?select=id,owner_user_id,name,active_network,updated_at&order=id.asc&limit=500",
    { token }
  ) || [];
  const start = allBusinesses.length
    ? (Math.floor(now.getTime() / OPERATIONS_MONITOR_INTERVAL_MS) * MAX_MONITORED_BUSINESSES_PER_CYCLE) % allBusinesses.length
    : 0;
  const businesses = Array.from(
    { length: Math.min(MAX_MONITORED_BUSINESSES_PER_CYCLE, allBusinesses.length) },
    (_, index) => allBusinesses[(start + index) % allBusinesses.length]
  );
  const results = [];
  for (const record of businesses) {
    const network = record.active_network || "ARC-TESTNET";
    try {
      const states = await supabaseRest(
        "operations_service_states?select=last_checked_at&business_id=eq." + encodeURIComponent(record.id) +
          "&network=eq." + encodeURIComponent(network) + "&order=last_checked_at.desc&limit=1",
        { token }
      ) || [];
      const lastCheckedAt = Date.parse(String(states[0]?.last_checked_at || ""));
      if (Number.isFinite(lastCheckedAt) && now.getTime() - lastCheckedAt < OPERATIONS_MONITOR_INTERVAL_MS) {
        results.push({ businessId: record.id, network, status: "skipped_recent" });
        continue;
      }
      const business = await getBusinessForNetwork(token, record.owner_user_id, network);
      if (!business || business.id !== record.id) throw new Error("Business isolation check failed");
      const health = await probeBusinessOperations(token, { id: record.owner_user_id }, business);
      const services = await persistOperationsHealth(token, business, record.owner_user_id, health);
      results.push({ businessId: record.id, network, status: health.overall, services });
    } catch (error) {
      await sendOperationsSystemAlert({
        service: "supabase",
        detail: "The scheduled business health check could not read or persist durable state",
        action: "Restore Supabase access before financial operations",
        incidentKey: [record.id, network, "supabase-monitor"].join(":"),
        checkedAt: now.toISOString()
      }).catch(() => {});
      results.push({
        businessId: record.id,
        network,
        status: "monitor_failed",
        error: "Operational monitor failed safely"
      });
    }
  }
  return results;
}

export function autonomousExecutionTarget(invoice, now = new Date()) {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error("Autonomy clock is invalid");
  if (invoice?.decision === "PAY_NOW") {
    return { jobKind: "pay_now", scheduledFor: current.toISOString() };
  }
  if (invoice?.decision !== "SCHEDULE" || !invoice?.due_date) return null;
  const due = new Date(String(invoice.due_date).slice(0, 10) + "T09:00:00.000Z");
  if (Number.isNaN(due.getTime())) return null;
  return {
    jobKind: "scheduled_payment",
    scheduledFor: new Date(Math.max(due.getTime(), current.getTime())).toISOString()
  };
}

export function preserveScheduledExecution(existingJob, target) {
  if (
    existingJob?.job_kind === "scheduled_payment" &&
    target?.jobKind === "pay_now" &&
    existingJob?.scheduled_for
  ) {
    return {
      jobKind: "scheduled_payment",
      scheduledFor: existingJob.scheduled_for
    };
  }
  return target;
}

export function autonomyFailureDisposition(message, attemptCount, maxAttempts, now = new Date()) {
  const reason = String(message || "Autonomous execution failed");
  const deterministic = /agent decision|vendor is not verified|settlement rail|policy is paused|per-payment limit|daily limit|cash floor|allowance|VENDOR_NOT_ALLOWED|DUPLICATE_PAYMENT|already settled|requires review|active payment environment changed|policy vault is not ready|wallet is not ready/i.test(reason);
  if (deterministic) return { status: "held", nextAttemptAt: null, terminal: true };
  if (attemptCount >= maxAttempts) return { status: "failed", nextAttemptAt: null, terminal: true };
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)];
  return {
    status: "retry",
    nextAttemptAt: new Date(new Date(now).getTime() + delay).toISOString(),
    terminal: false
  };
}

async function audit(token, values) {
  await supabaseRest("audit_events", { token: getSupabaseServerSecret(), method: "POST", body: values });
}

async function updatePolicyRun(token, policy, patch) {
  await supabaseRest(
    "policies?id=eq." + encodeURIComponent(policy.id) +
      "&business_id=eq." + encodeURIComponent(policy.business_id) +
      "&network=eq." + encodeURIComponent(policy.network),
    { token, method: "PATCH", body: { ...patch, updated_at: new Date().toISOString() } }
  );
}

async function executionJob(token, invoiceId) {
  const rows = await supabaseRest(
    "invoice_execution_jobs?select=*&invoice_id=eq." + encodeURIComponent(invoiceId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function autonomyJobStates(token, businessId, network, invoices = []) {
  const ids = (invoices || []).map((invoice) => invoice?.id).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await supabaseRest(
    "invoice_execution_jobs?select=id,invoice_id,job_kind,status,scheduled_for,next_attempt_at,attempt_count,max_attempts,last_error,last_result,updated_at" +
      "&business_id=eq." + encodeURIComponent(businessId) +
      "&network=eq." + encodeURIComponent(network) +
      "&invoice_id=in.(" + ids.map(encodeURIComponent).join(",") + ")",
    { token }
  );
  return new Map((rows || []).map((job) => [job.invoice_id, job]));
}

export async function enqueueAutonomousInvoices(token, business, userId, invoices, now = new Date()) {
  const queued = [];
  for (const invoice of invoices || []) {
    if (!invoice?.id || invoice.settlement_status === "confirmed") continue;
    const target = autonomousExecutionTarget(invoice, now);
    if (!target) continue;

    const existing = await executionJob(token, invoice.id);
    if (existing) {
      if (["completed", "leased", "reconciling", "failed"].includes(existing.status)) continue;
      const effectiveTarget = preserveScheduledExecution(existing, target);
      const rows = await supabaseRest(
        "invoice_execution_jobs?id=eq." + encodeURIComponent(existing.id) +
          "&business_id=eq." + encodeURIComponent(business.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain),
        {
          token,
          method: "PATCH",
          body: {
            job_kind: effectiveTarget.jobKind,
            status: "queued",
            scheduled_for: effectiveTarget.scheduledFor,
            next_attempt_at: effectiveTarget.scheduledFor,
            last_error: null,
            lease_owner: null,
            lease_expires_at: null,
            updated_at: new Date().toISOString()
          }
        }
      );
      if (rows?.[0]) queued.push(rows[0]);
      continue;
    }

    try {
      const rows = await supabaseRest("invoice_execution_jobs", {
        token,
        method: "POST",
        body: {
          business_id: business.id,
          user_id: userId,
          invoice_id: invoice.id,
          network: business.wallet_blockchain,
          job_kind: target.jobKind,
          status: "queued",
          scheduled_for: target.scheduledFor,
          next_attempt_at: target.scheduledFor
        }
      });
      if (rows?.[0]) {
        queued.push(rows[0]);
        await audit(token, {
          user_id: userId,
          business_id: business.id,
          network: business.wallet_blockchain,
          invoice_id: invoice.id,
          event_type: "invoice_autonomy_queued",
          actor: "agent",
          data: {
            job_id: rows[0].id,
            invoice_number: invoice.invoice_number,
            job_kind: target.jobKind,
            scheduled_for: target.scheduledFor
          }
        });
      }
    } catch (error) {
      if (!/^Supabase (?:admin )?409:/i.test(String(error?.message || ""))) throw error;
    }
  }
  return queued;
}

async function markJob(token, job, patch) {
  const rows = await supabaseRest(
    "invoice_execution_jobs?id=eq." + encodeURIComponent(job.id) +
      "&lease_owner=eq." + encodeURIComponent(job.lease_owner || ""),
    {
      token,
      method: "PATCH",
      body: {
        ...patch,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString()
      }
    }
  );
  return rows?.[0] || null;
}

async function loadJobContext(token, job) {
  const [policyRows, invoiceRows] = await Promise.all([
    supabaseRest(
      "policies?select=*&business_id=eq." + encodeURIComponent(job.business_id) +
        "&network=eq." + encodeURIComponent(job.network) + "&limit=1",
      { token }
    ),
    supabaseRest(
      "invoices?select=*&id=eq." + encodeURIComponent(job.invoice_id) +
        "&business_id=eq." + encodeURIComponent(job.business_id) +
        "&settlement_network=eq." + encodeURIComponent(job.network) + "&limit=1",
      { token }
    )
  ]);
  return { policy: policyRows?.[0] || null, invoice: invoiceRows?.[0] || null };
}

export async function executeAutonomyJob(token, job, now = new Date()) {
  const { policy, invoice } = await loadJobContext(token, job);
  if (!policy?.autonomy_enabled) {
    await markJob(token, job, { status: "cancelled", last_error: "Business autonomy is disabled" });
    return { jobId: job.id, status: "cancelled" };
  }
  if (!invoice) {
    await markJob(token, job, { status: "failed", last_error: "Invoice no longer exists" });
    return { jobId: job.id, status: "failed" };
  }
  if (invoice.settlement_status === "confirmed") {
    await markJob(token, job, { status: "completed", completed_at: new Date(now).toISOString(), last_error: null });
    return { jobId: job.id, status: "completed", idempotent: true };
  }
  if (invoice.decision !== "PAY_NOW" && invoice.settlement_status !== "processing") {
    const reason = "Current invoice decision is " + (invoice.decision || "unknown") + "; autonomous payment requires PAY_NOW";
    await markJob(token, job, { status: "held", last_error: reason });
    return { jobId: job.id, status: "held", error: reason };
  }

  const business = await getBusinessForNetwork(token, job.user_id, job.network);
  if (!business || business.id !== job.business_id) {
    const reason = "Business ownership or network account no longer matches this job";
    await markJob(token, job, { status: "failed", last_error: reason });
    return { jobId: job.id, status: "failed", error: reason };
  }

  try {
    await audit(token, {
      user_id: job.user_id,
      business_id: job.business_id,
      network: job.network,
      invoice_id: job.invoice_id,
      event_type: "invoice_autonomy_attempted",
      actor: "agent",
      data: {
        job_id: job.id,
        invoice_number: invoice.invoice_number,
        job_kind: job.job_kind,
        attempt: job.attempt_count,
        scheduled_for: job.scheduled_for
      }
    });
    const result = await settleBusinessInvoice(token, job.user_id, invoice.invoice_number, job.network);
    if (result.status === "confirmed") {
      await markJob(token, job, {
        status: "completed",
        completed_at: new Date(now).toISOString(),
        last_error: null,
        last_result: result
      });
      await audit(token, {
        user_id: job.user_id,
        business_id: job.business_id,
        network: job.network,
        invoice_id: job.invoice_id,
        event_type: "invoice_autonomy_completed",
        actor: "agent",
        data: { job_id: job.id, invoice_number: invoice.invoice_number, tx_hash: result.paymentTxHash || null }
      });
      return { jobId: job.id, status: "completed", result };
    }

    if (result.status === "failed") {
      const reason = result.recoveryMessage || "The submitted payment failed before Arc settlement";
      const disposition = autonomyFailureDisposition(reason, job.attempt_count, job.max_attempts, now);
      await markJob(token, job, {
        status: disposition.status,
        next_attempt_at: disposition.nextAttemptAt || job.next_attempt_at,
        last_error: reason,
        last_result: result
      });
      return { jobId: job.id, status: disposition.status, result };
    }

    const status = result.status === "review" ? "held" : "reconciling";
    await markJob(token, job, {
      status,
      next_attempt_at: status === "reconciling"
        ? new Date(new Date(now).getTime() + 2 * 60_000).toISOString()
        : job.next_attempt_at,
      last_error: result.recoveryMessage || (status === "held" ? "Settlement requires review" : null),
      last_result: result
    });
    return { jobId: job.id, status, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const disposition = autonomyFailureDisposition(message, job.attempt_count, job.max_attempts, now);
    await markJob(token, job, {
      status: disposition.status,
      next_attempt_at: disposition.nextAttemptAt || job.next_attempt_at,
      last_error: message,
      last_result: { error: message }
    });
    await audit(token, {
      user_id: job.user_id,
      business_id: job.business_id,
      network: job.network,
      invoice_id: job.invoice_id,
      event_type: disposition.terminal ? "invoice_autonomy_stopped" : "invoice_autonomy_retry_scheduled",
      actor: "agent",
      data: {
        job_id: job.id,
        invoice_number: invoice.invoice_number,
        attempt: job.attempt_count,
        max_attempts: job.max_attempts,
        next_attempt_at: disposition.nextAttemptAt,
        reason: message
      }
    }).catch(() => {});
    return { jobId: job.id, status: disposition.status, error: message };
  }
}

export async function runAutonomyCycle({ now = new Date(), batchSize = DEFAULT_BATCH_SIZE, workerId = crypto.randomUUID() } = {}) {
  const token = getSupabaseServerSecret();
  let customerNotifications = [];
  try {
    customerNotifications = await deliverBusinessPaymentNotifications(token);
  } catch (error) {
    console.warn("InboxPay customer payment alert queue unavailable", { reason: "queue_unavailable" });
    customerNotifications = [{ outcome: "queue_unavailable" }];
  }
  const withdrawals = await reconcilePendingWithdrawals(token, 5);
  let monitoring;
  try {
    monitoring = await runOperationalMonitoring(token, now);
  } catch (error) {
    await sendOperationsSystemAlert({
      service: "supabase",
      detail: "The scheduled health monitor could not read the business registry",
      action: "Restore Supabase access before financial operations",
      incidentKey: "global:supabase-monitor",
      checkedAt: now.toISOString()
    }).catch(() => {});
    monitoring = [{ status: "monitor_failed", error: "Operational monitor failed safely" }];
  }
  const policies = await supabaseRest(
    "policies?select=*&autonomy_enabled=eq.true&paused=eq.false&order=updated_at.asc&limit=" + MAX_POLICIES_PER_CYCLE,
    { token }
  ) || [];
  const syncResults = [];

  for (const policy of policies) {
    const startedAt = new Date().toISOString();
    try {
      const business = await getBusinessForNetwork(token, policy.user_id, policy.network);
      if (!business || business.id !== policy.business_id) throw new Error("Business isolation check failed");
      const sync = await syncBusinessInvoicesForNetwork(token, policy.user_id, policy.network);
      const queued = await enqueueAutonomousInvoices(token, business, policy.user_id, sync.invoices, now);
      await updatePolicyRun(token, policy, {
        autonomy_last_run_at: startedAt,
        autonomy_last_success_at: new Date().toISOString(),
        autonomy_last_error: null
      });
      syncResults.push({ businessId: policy.business_id, network: policy.network, invoices: sync.invoices.length, queued: queued.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updatePolicyRun(token, policy, { autonomy_last_run_at: startedAt, autonomy_last_error: message }).catch(() => {});
      syncResults.push({ businessId: policy.business_id, network: policy.network, error: message });
    }
  }

  const claimed = await supabaseRest("rpc/claim_invoice_execution_jobs", {
    token,
    method: "POST",
    body: { worker_id: workerId, batch_size: batchSize, lease_seconds: LEASE_SECONDS }
  }) || [];
  const executions = [];
  for (const job of claimed) executions.push(await executeAutonomyJob(token, job, now));
  return {
    workerId,
    customerNotifications,
    withdrawalsReconciled: withdrawals.filter((withdrawal) => withdrawal.status !== "processing").length,
    monitoring,
    policies: policies.length,
    syncResults,
    claimed: claimed.length,
    executions
  };
}
