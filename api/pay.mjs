import { requireUser } from "../lib/supabase-server.mjs";
import { settleBusinessInvoice } from "../lib/business-payment.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const invoiceNumber = String(req.body?.invoiceNumber || "").trim();
    if (!invoiceNumber) return res.status(400).json({ error: "invoiceNumber is required" });

    const result = await settleBusinessInvoice(token, user.id, invoiceNumber);
    return res.status(200).json({
      ok: true,
      message: "Invoice settled from the business's dedicated Circle wallet on Arc",
      result
    });
  } catch (error) {
    console.error("InboxPay /api/pay failed:", error);
    const message = error instanceof Error ? error.message : "Settlement failed";
    const status = /Authentication required|Invalid or expired/i.test(message) ? 401 : 400;
    return res.status(status).json({ ok: false, error: message });
  }
}
