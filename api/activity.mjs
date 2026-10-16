import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { getFreshGmailAccessToken } from "../lib/gmail-account.mjs";
import { probeGmailConnection } from "../lib/gmail-live.mjs";
import { getBusinessWalletUsdcAsset } from "../lib/circle-wallets.mjs";
import { chainFor, policyClient } from "../lib/policy-sync.mjs";
import {
  buildOperationsHealth,
  operationRecoveryItems,
  sanitizeOperationsError,
  withTimeout
} from "../lib/operations-health.mjs";

function fulfilled(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function failedService(key, label, result, action) {
  return {
    key,
    label,
    status: "degraded",
    detail: sanitizeOperationsError(result.reason),
    action
  };
}

async function operationsView(token, user, business) {
  const checkedAt = new Date().toISOString();
  const network = business.wallet_blockchain;
  const scoped = "&business_id=eq." + encodeURIComponent(business.id) +
    "&user_id=eq." + encodeURIComponent(user.id) +
    "&network=eq." + encodeURIComponent(network);

  const gmailProbe = (async () => {
    const { accessToken } = await getFreshGmailAccessToken(token, user.id, business.id);
    return probeGmailConnection(accessToken);
  })();
  const circleProbe = business.wallet_id
    ? withTimeout(getBusinessWalletUsdcAsset(business.wallet_id, network), 7000, "Circle")
    : Promise.resolve(null);
  const arcProbe = withTimeout(policyClient(network).getChainId(), 7000, "Arc RPC");
  const jobsProbe = supabaseRest(
    "invoice_execution_jobs?select=id,invoice_id,job_kind,status,scheduled_for,next_attempt_at,attempt_count,max_attempts,updated_at" + scoped +
      "&status=in.(queued,leased,retry,reconciling,held,failed)&order=updated_at.desc&limit=50",
    { token }
  );
  const withdrawalsProbe = supabaseRest(
    "wallet_withdrawals?select=id,request_id,status,updated_at" + scoped +
      "&status=in.(processing,review,failed)&order=updated_at.desc&limit=50",
    { token }
  );
  const invoicesProbe = supabaseRest(
    "invoices?select=id,invoice_number,vendor,settlement_status,updated_at&business_id=eq." + encodeURIComponent(business.id) +
      "&user_id=eq." + encodeURIComponent(user.id) +
      "&settlement_network=eq." + encodeURIComponent(network) +
      "&settlement_status=in.(processing,reconciling,review,failed)&order=updated_at.desc&limit=50",
    { token }
  );

  const [gmail, circle, arc, jobs, withdrawals, invoices] = await Promise.allSettled([
    withTimeout(gmailProbe, 8000, "Gmail"),
    circleProbe,
    arcProbe,
    jobsProbe,
    withdrawalsProbe,
    invoicesProbe
  ]);

  const services = [];
  if (gmail.status === "fulfilled") {
    services.push(gmail.value
      ? { key: "gmail", label: "Gmail", status: "healthy", detail: "Connected inbox is reachable", action: "No action required" }
      : { key: "gmail", label: "Gmail", status: "attention", detail: "Business inbox is not connected", action: "Connect Gmail to resume invoice discovery" });
  } else {
    const detail = sanitizeOperationsError(gmail.reason);
    services.push({
      key: "gmail",
      label: "Gmail",
      status: detail === "Authorization needs renewal" || /Connect Gmail/i.test(String(gmail.reason?.message || "")) ? "attention" : "degraded",
      detail,
      action: detail === "Authorization needs renewal" ? "Reconnect Gmail" : "Retry the health check"
    });
  }

  if (!business.wallet_id) {
    services.push({ key: "circle", label: "Circle", status: "attention", detail: "Dedicated business wallet is not provisioned", action: "Provision this environment's wallet" });
  } else if (circle.status === "fulfilled") {
    services.push({ key: "circle", label: "Circle", status: "healthy", detail: "Dedicated wallet and USDC asset are reachable", action: "No action required" });
  } else {
    services.push(failedService("circle", "Circle", circle, "Retry the health check before submitting a payment"));
  }

  if (arc.status === "fulfilled" && Number(arc.value) === chainFor(network)) {
    services.push({ key: "arc", label: "Arc RPC", status: "healthy", detail: "Connected to the expected settlement chain", action: "No action required" });
  } else if (arc.status === "fulfilled") {
    services.push({ key: "arc", label: "Arc RPC", status: "degraded", detail: "RPC returned the wrong chain", action: "Correct the configured Arc endpoint" });
  } else {
    services.push(failedService("arc", "Arc RPC", arc, "Retry before any settlement authorization"));
  }

  const durableReads = [jobs, withdrawals, invoices];
  const supabaseReady = durableReads.every((result) => result.status === "fulfilled");
  services.push(supabaseReady
    ? { key: "supabase", label: "Supabase", status: "healthy", detail: "Business data and recovery queues are reachable", action: "No action required" }
    : { key: "supabase", label: "Supabase", status: "degraded", detail: "A durable recovery queue could not be read", action: "Restore database access before financial operations" });

  const recoveries = operationRecoveryItems({
    jobs: fulfilled(jobs) || [],
    withdrawals: fulfilled(withdrawals) || [],
    invoices: fulfilled(invoices) || []
  });
  const attentionCount = recoveries.filter((item) => item.state === "attention").length;
  const recoveringCount = recoveries.filter((item) => item.state === "recovering").length;
  services.push({
    key: "reconciliation",
    label: "Reconciliation",
    status: !supabaseReady ? "degraded" : attentionCount ? "attention" : recoveringCount ? "recovering" : "healthy",
    detail: !supabaseReady
      ? "Reconciliation state is unavailable"
      : attentionCount
        ? `${attentionCount} record${attentionCount === 1 ? "" : "s"} need operator review`
        : recoveringCount
          ? `${recoveringCount} record${recoveringCount === 1 ? " is" : "s are"} recovering automatically`
          : "No unresolved payment or withdrawal records",
    action: attentionCount ? "Review the recovery queue below" : recoveringCount ? "Monitor the bounded retry window" : "No action required"
  });

  return {
    business,
    ...buildOperationsHealth({ checkedAt, services, recoveries })
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    const view = String(req.query?.view || "").toLowerCase();
    if (view === "payments") {
      const rows = await supabaseRest(
        "invoices?select=id,invoice_number,vendor,amount,currency,due_date,decision,settlement_status,payment_id,payment_tx_hash,settlement_network,updated_at&business_id=eq." + encodeURIComponent(business.id) +
          "&user_id=eq." + encodeURIComponent(user.id) +
          "&settlement_network=eq." + encodeURIComponent(business.wallet_blockchain) + "&order=updated_at.desc&limit=100",
        { token }
      );
      const payments = (rows || []).filter((invoice) => invoice.settlement_status).map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        vendor: invoice.vendor,
        amount: Number(invoice.amount || 0),
        currency: invoice.currency,
        status: invoice.settlement_status,
        paymentId: invoice.payment_id,
        paymentTxHash: invoice.payment_tx_hash,
        network: invoice.settlement_network,
        updatedAt: invoice.updated_at
      }));
      return res.status(200).json({ business, count: payments.length, payments });
    }
    if (view === "audit") {
      const events = await supabaseRest(
        "audit_events?select=id,event_type,actor,data,invoice_id,business_id,network,created_at&business_id=eq." + encodeURIComponent(business.id) +
          "&user_id=eq." + encodeURIComponent(user.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain) + "&order=created_at.desc&limit=100",
        { token }
      );
      return res.status(200).json({ business, count: events?.length || 0, events: events || [] });
    }
    if (view === "operations") {
      return res.status(200).json(await operationsView(token, user, business));
    }
    return res.status(400).json({ error: "Activity view must be payments, audit, or operations" });
  } catch (error) {
    console.error("InboxPay /api/activity failed:", error);
    const message = error instanceof Error ? error.message : "Activity unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}

