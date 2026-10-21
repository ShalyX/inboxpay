import { rejectPreviewRequest, isReadOnlyPreview } from "../lib/preview-boundary.mjs";
import { requireUser } from "../lib/supabase-server.mjs";
import { listBusinessInvoices, syncBusinessInvoices } from "../lib/business-data.mjs";
import { recoverPendingBusinessInvoices } from "../lib/business-payment.mjs";
import { advanceDueSchedules, invoiceScheduleStates, scheduleBusinessInvoice } from "../lib/invoice-scheduling.mjs";
import { classifyInvoiceRouteError } from "../lib/invoice-route-errors.mjs";
import { autonomyJobStates, runAutonomyCycle } from "../lib/autonomy.mjs";
import { requireAutonomyWorker } from "../lib/worker-auth.mjs";

export default async function handler(req, res) {
  if (rejectPreviewRequest(req, res)) return;
  if (!["GET", "PATCH", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, PATCH, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    if (req.method === "POST" && String(req.body?.action || "").toLowerCase() === "autonomy_tick") {
      requireAutonomyWorker(req);
      const result = await runAutonomyCycle();
      return res.status(200).json({ ok: true, ...result });
    }

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
        scheduledFor: req.body?.scheduledFor,
        expectedNetwork: String(req.body?.network || "")
      });
      return res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result });
    }

    if (req.method === "POST") {
      const action = String(req.body?.action || "").toLowerCase();
      if (action !== "review_due") return res.status(400).json({ error: "Invoice action must be review_due" });
      const current = await listBusinessInvoices(token, user.id);
      if (String(req.body?.network || "") !== current.business.wallet_blockchain) {
        return res.status(409).json({ error: "The active invoice environment changed. Refresh and try again." });
      }
      const result = await advanceDueSchedules(token, user.id, current.business, current.invoices || []);
      return res.status(200).json({ ok: true, business: current.business, ...result });
    }

    const preview = isReadOnlyPreview();
    const result = preview ? await listBusinessInvoices(token, user.id) : await syncBusinessInvoices(token, user.id);
    const recoveredInvoices = preview ? result.invoices || [] : await recoverPendingBusinessInvoices(
      token,
      user.id,
      result.business,
      result.invoices || []
    );

    const scheduleStates = await invoiceScheduleStates(
      token,
      result.business.id,
      user.id,
      recoveredInvoices,
      result.business.wallet_blockchain
    );
    const autonomyStates = await autonomyJobStates(
      token,
      result.business.id,
      result.business.wallet_blockchain,
      recoveredInvoices
    );
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
      autonomy: autonomyStates.get(invoice.id) || null,
      schedule: ["scheduled", "review"].includes(invoice.settlement_status)
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
      source: preview ? "saved-records-preview" : "gmail-live",
      liveGmail: !preview,
      previewReadOnly: preview,
      business: result.business,
      gmail: result.gmail,
      invoices
    });
  } catch (error) {
    if (error?.statusCode === 401) {
      return res.status(401).json({ error: "Autonomy worker authentication failed" });
    }
    const failure = classifyInvoiceRouteError(error);
    if (failure.log === "warning") {
      console.warn("InboxPay /api/invoices requires Gmail reauthorization");
    } else if (failure.log === "error") {
      console.error("InboxPay /api/invoices failed:", error);
    }
    return res.status(failure.status).json(failure.body);
  }
}
