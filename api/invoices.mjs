import { getInvoices } from "../lib/inboxpay.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const result = await getInvoices();
    return res.status(200).json(result);
  } catch (error) {
    console.error("InboxPay /api/invoices failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Invoice data unavailable"
    });
  }
}
