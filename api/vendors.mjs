import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/business-data.mjs";

export default async function handler(req, res) {
  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });

    if (req.method === "GET") {
      const vendors = await supabaseRest(
        "vendors?select=id,name,recipient_address,currency,status&business_id=eq." + encodeURIComponent(business.id) + "&order=name",
        { token }
      );
      return res.status(200).json({ vendors: vendors || [] });
    }

    if (req.method === "PATCH") {
      const id = String(req.body?.id || "").trim();
      const status = String(req.body?.status || "").trim();
      if (!id || !["verified", "review", "blocked"].includes(status)) {
        return res.status(400).json({ error: "Vendor id and valid status are required" });
      }
      const rows = await supabaseRest(
        "vendors?id=eq." + encodeURIComponent(id) + "&business_id=eq." + encodeURIComponent(business.id),
        { token, method: "PATCH", body: { status, updated_at: new Date().toISOString() } }
      );
      return res.status(200).json({ vendor: rows?.[0] || null });
    }

    if (req.method === "POST") {
      const name = String(req.body?.name || "").trim();
      const recipientAddress = String(req.body?.recipientAddress || "").trim();
      const currency = String(req.body?.currency || "USDC").toUpperCase();

      if (!name || !/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        return res.status(400).json({ error: "Vendor name and valid EVM recipient address are required" });
      }
      if (currency !== "USDC") {
        return res.status(400).json({ error: "InboxPay currently settles vendor invoices in USDC" });
      }

      const rows = await supabaseRest("vendors", {
        token,
        method: "POST",
        body: {
          business_id: business.id,
          name,
          recipient_address: recipientAddress,
          currency,
          status: "review"
        }
      });
      return res.status(201).json({ vendor: rows?.[0] || null });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    console.error("InboxPay vendors failed:", error);
    const message = error instanceof Error ? error.message : "Vendor request failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
