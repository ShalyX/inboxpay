import { getInvoices } from "../lib/inboxpay.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }
  try {
    const data = await getInvoices();
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(data));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      error: error instanceof Error ? error.message : "Invoice data unavailable"
    }));
  }
}
