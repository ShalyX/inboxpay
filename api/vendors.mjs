import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { writePolicy } from "../lib/policy-sync.mjs";
import { keccak256 } from "viem";

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
      const existingRows = await supabaseRest(
        "vendors?select=*&id=eq." + encodeURIComponent(id) + "&business_id=eq." + encodeURIComponent(business.id) + "&limit=1",
        { token }
      );
      const vendor = existingRows?.[0];
      if (!vendor) return res.status(404).json({ error: "Vendor not found" });

      if (business.policy_contract_status === "ready" && business.policy_contract_address) {
        const vendorId = keccak256(new TextEncoder().encode("vendor:" + vendor.name));
        const recipient = status === "verified" ? vendor.recipient_address : "0x0000000000000000000000000000000000000000";
        const tx = await writePolicy({
          walletId: business.wallet_id,
          contractAddress: business.policy_contract_address,
          abiFunctionSignature: "setVendor(bytes32,address)",
          abiParameters: [vendorId, recipient],
          blockchain: business.wallet_blockchain
        });
        await supabaseRest("audit_events", {
          token,
          method: "POST",
          body: {
            user_id: user.id,
            business_id: business.id,
            event_type: "vendor_policy_updated",
            actor: "user",
            data: { vendor: vendor.name, status, tx_hash: tx.txHash }
          }
        });
      }

      const rows = await supabaseRest(
        "vendors?id=eq." + encodeURIComponent(id) + "&business_id=eq." + encodeURIComponent(business.id),
        { token, method: "PATCH", body: { status, updated_at: new Date().toISOString() } }
      );
      return res.status(200).json({ vendor: rows?.[0] || { ...vendor, status } });
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
