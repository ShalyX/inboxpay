import { requireUser } from "../lib/supabase-server.mjs";
import { syncBusinessInvoices } from "../lib/business-data.mjs";
import { recoverPendingBusinessInvoices } from "../lib/business-payment.mjs";
import { invoiceScheduleStates, scheduleBusinessInvoice } from "../lib/invoice-scheduling.mjs";

export default async function handler(req, res) {
  if (!["GET", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    if (req.method === "PATCH") {
      const action = String(req.body?.action || "").toLowerCase();
      if (!["schedule", "reschedule", "cancel_schedule"].includes(action)) {
        return res.status(400).json({ error: "Invoice action must be schedule, reschedule, or cancel_schedule" });
      }
      const invoiceNumber = String(req.body?.invoiceNumber || "").trim();
      if (!invoiceNumber) return res.status(400).json({ error: "Invoice number is required" });
      const result = await scheduleBusinessInvoice(token, user.id, invoiceNumber, {
        action: action === "cancel_schedule" ? "cancel" : action,
        scheduledFor: req.body?.scheduledFor
      });
      return res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result });
    }

    const result = await syncBusinessInvoices(token, user.id);
    const recoveredInvoices = await recoverPendingBusinessInvoices(
      token,
      user.id,
      result.business,
      result.invoices || []
    );

    const scheduleStates = await invoiceScheduleStates(token, result.business.id, user.id, recoveredInvoices);
    const invoices = recoveredInvoices.map((invoice) => ({
      vendor: invoice.vendor,
      invoiceNumber: invoice.invoice_number,
      amount: Number(invoice.amount || 0),
      currency: invoice.currency,
      dueDate: invoice.due_date,
      agentDecision: invoice.decision,
      decisionReasons: invoice.decision_reasons,
      extraction: invoice.extraction,
      sourceCount: invoice.sources?.length || 0,
      sources: invoice.sources,
      paymentId: invoice.payment_id,
      schedule: invoice.settlement_status === "scheduled"
        ? (scheduleStates.get(invoice.id) || { status: "queued", scheduledFor: null, reason: "Schedule target is awaiting audit reconciliation" })
        : null,
      settlement: invoice.settlement_status
        ? {
            status: invoice.settlement_status,
            paymentTxHash: invoice.payment_tx_hash,
            reconciled: invoice.settlement_status === "confirmed",
            pending: ["processing"].includes(invoice.settlement_status),
            retryable: invoice.settlement_status === "failed"
          }
        : null
    }));

    return res.status(200).json({
      evaluatedAt: result.scannedAt,
      count: invoices.length,
      source: "gmail-live",
      liveGmail: true,
      business: result.business,
      gmail: result.gmail,
      invoices
    });
  } catch (error) {
    console.error("InboxPay /api/invoices failed:", error);
    const message = error instanceof Error ? error.message : "Invoice data unavailable";
    const status = /Authentication required|Invalid or expired/i.test(message) ? 401 : 500;
    return res.status(status).json({ error: message });
  }
}
