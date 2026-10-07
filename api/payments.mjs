import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    const rows = await supabaseRest(
      "invoices?select=id,invoice_number,vendor,amount,currency,due_date,decision,settlement_status,payment_id,payment_tx_hash,updated_at&business_id=eq." + encodeURIComponent(business.id) + "&user_id=eq." + encodeURIComponent(user.id) + "&order=updated_at.desc&limit=100",
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
      network: business.wallet_blockchain,
      updatedAt: invoice.updated_at
    }));
    return res.status(200).json({ business, count: payments.length, payments });
  } catch (error) {
    console.error("InboxPay /api/payments failed:", error);
    const message = error instanceof Error ? error.message : "Payment history unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
