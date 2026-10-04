import { requireUser } from "../lib/supabase-server.mjs";
import { syncBusinessInvoices } from "../lib/business-data.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const result = await syncBusinessInvoices(token, user.id);

    const invoices = (result.invoices || []).map((invoice) => ({
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
      settlement: invoice.settlement_status
        ? {
            status: invoice.settlement_status,
            paymentTxHash: invoice.payment_tx_hash,
            reconciled: invoice.settlement_status === "confirmed"
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
