import { settleInvoice } from "../lib/inboxpay.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const invoiceNumber = req.body?.invoiceNumber;
    if (!invoiceNumber || typeof invoiceNumber !== "string") {
      return res.status(400).json({ error: "invoiceNumber is required" });
    }

    const result = await settleInvoice(invoiceNumber);
    return res.status(200).json({
      ok: true,
      message: "Invoice settled on Arc",
      result
    });
  } catch (error) {
    console.error("InboxPay /api/pay failed:", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Settlement failed"
    });
  }
}
