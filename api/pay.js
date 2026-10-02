import { settleInvoice } from "../lib/inboxpay.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (!body.invoiceNumber) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ message: "invoiceNumber is required" }));
    }
    const result = await settleInvoice(body.invoiceNumber);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, message: "Invoice settled on Arc", result }));
  } catch (error) {
    res.statusCode = 409;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : "Settlement failed"
    }));
  }
}
