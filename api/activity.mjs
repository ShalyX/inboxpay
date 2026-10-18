import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { probeBusinessOperations } from "../lib/operations-monitor.mjs";

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
      const [health, serviceStates] = await Promise.all([
        probeBusinessOperations(token, user, business),
        supabaseRest(
          "operations_service_states?select=service,status,severity,detail,action,consecutive_failures,last_checked_at,last_transition_at,last_notified_at,notification_error" +
            "&business_id=eq." + encodeURIComponent(business.id) +
            "&user_id=eq." + encodeURIComponent(user.id) +
            "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
            "&order=last_checked_at.desc",
          { token }
        ).catch(() => [])
      ]);
      return res.status(200).json({
        ...health,
        alerting: {
          deliveryConfigured: Boolean(process.env.OPERATIONS_ALERT_WEBHOOK_URL),
          states: serviceStates || []
        }
      });
    }
    return res.status(400).json({ error: "Activity view must be payments, audit, or operations" });
  } catch (error) {
    console.error("InboxPay /api/activity failed:", error);
    const message = error instanceof Error ? error.message : "Activity unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
