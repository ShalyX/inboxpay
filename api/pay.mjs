import { requireUser } from "../lib/supabase-server.mjs";
import { settleBusinessInvoice } from "../lib/business-payment.mjs";
import { getBusiness } from "../lib/businesses.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const invoiceNumber = String(req.body?.invoiceNumber || "").trim();
    if (!invoiceNumber) return res.status(400).json({ error: "invoiceNumber is required" });

    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
      return res.status(409).json({
        error: "Arc Mainnet payment requires explicit confirmation",
        confirmation: {
          network: "Arc Mainnet",
          invoiceNumber,
          wallet: business.wallet_address,
          policyVault: business.policy_contract_address
        }
      });
    }

    const result = await settleBusinessInvoice(token, user.id, invoiceNumber);
    const statusCode = result?.status === "processing" ? 202 : 200;
    return res.status(statusCode).json({
      ok: true,
      message: result?.status === "processing"
        ? "Payment submitted from the business's dedicated Circle wallet; Arc reconciliation is still in progress"
        : "Invoice settled from the business's dedicated Circle wallet on Arc",
      result
    });
  } catch (error) {
    console.error("InboxPay /api/pay failed:", error);
    const message = error instanceof Error ? error.message : "Settlement failed";
    const status = /Authentication required|Invalid or expired/i.test(message) ? 401 : 400;
    return res.status(status).json({ ok: false, error: message });
  }
}
