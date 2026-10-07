import { requireUser } from "../lib/supabase-server.mjs";
import { previewBusinessInvoice } from "../lib/payment-preflight-server.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const invoiceNumber = String(req.query?.invoice || "").trim();
    if (!invoiceNumber) return res.status(400).json({ error: "Invoice number is required" });
    const result = await previewBusinessInvoice(token, user.id, invoiceNumber);
    return res.status(200).json(result);
  } catch (error) {
    console.error("InboxPay /api/preflight failed:", error);
    const message = error instanceof Error ? error.message : "Payment preflight unavailable";
    const status = /Authentication required|Invalid or expired/i.test(message) ? 401 : /not found/i.test(message) ? 404 : 500;
    return res.status(status).json({ error: message });
  }
}

