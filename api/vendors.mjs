import { rejectPreviewRequest } from "../lib/preview-boundary.mjs";
import { getSupabaseServerSecret, requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { readVendorRecipient, readVendorRevocationSupported, writePolicy } from "../lib/policy-sync.mjs";
import { normalizeVendorEmails } from "../lib/gmail-live.mjs";
import { keccak256 } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export default async function handler(req, res) {
  if (rejectPreviewRequest(req, res)) return;
  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });

    if (req.method === "GET") {
      const vendors = await supabaseRest(
        "vendors?select=id,name,recipient_address,currency,status,network,invoice_sender_emails&business_id=eq." + encodeURIComponent(business.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain) + "&order=name",
        { token }
      );
      const withChainState = await Promise.all((vendors || []).map(async (vendor) => {
        if (vendor.status !== "verified" || business.policy_contract_status !== "ready" || !business.policy_contract_address) {
          return { ...vendor, onchain_status: null };
        }
        try {
          const vendorId = keccak256(new TextEncoder().encode("vendor:" + vendor.name));
          const recipient = await readVendorRecipient(business.policy_contract_address, vendorId, business.wallet_blockchain);
          return {
            ...vendor,
            onchain_status: recipient.toLowerCase() === vendor.recipient_address.toLowerCase() ? "registered" : "missing",
            onchain_recipient: recipient
          };
        } catch {
          return { ...vendor, onchain_status: "unavailable" };
        }
      }));
      const vendorRevocationSupported = business.policy_contract_address &&
        business.policy_contract_status === "ready"
        ? await readVendorRevocationSupported(business.policy_contract_address, business.wallet_blockchain)
        : null;
      return res.status(200).json({ vendors: withChainState, vendorRevocationSupported });
    }

    if (req.method === "PATCH") {
      if (String(req.body?.network || "") !== business.wallet_blockchain) {
        return res.status(409).json({ error: "The active vendor environment changed. Refresh and try again." });
      }
      const id = String(req.body?.id || "").trim();
      const status = String(req.body?.status || "").trim();
      const action = String(req.body?.action || "status").trim().toLowerCase();
      if (!id) return res.status(400).json({ error: "Vendor id is required" });
      if (action === "status" && !["verified", "review", "blocked"].includes(status)) {
        return res.status(400).json({ error: "A valid vendor status is required" });
      }
      const existingRows = await supabaseRest(
        "vendors?select=*&id=eq." + encodeURIComponent(id) + "&business_id=eq." + encodeURIComponent(business.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain) + "&limit=1",
        { token }
      );
      const vendor = existingRows?.[0];
      if (!vendor) return res.status(404).json({ error: "Vendor not found" });

      if (action === "update_sender_emails") {
        const requested = Array.isArray(req.body?.senderEmails) ? req.body.senderEmails : [];
        const senderEmails = normalizeVendorEmails(requested);
        if (requested.length > 5 || senderEmails.length !== requested.length) {
          return res.status(400).json({ error: "Provide up to five valid, unique invoice sender emails" });
        }
        if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
          return res.status(409).json({ error: "Mainnet vendor sender changes require explicit confirmation" });
        }
        const rows = await supabaseRest("rpc/update_vendor_invoice_senders", {
          token,
          method: "POST",
          body: {
            p_vendor_id: id,
            p_network: business.wallet_blockchain,
            p_sender_emails: senderEmails,
            p_confirm_mainnet: req.body?.confirmMainnet === true
          }
        });
        return res.status(200).json({ vendor: rows?.[0] || { ...vendor, invoice_sender_emails: senderEmails } });
      }
      if (action !== "status") return res.status(400).json({ error: "Unsupported vendor action" });
      if (status === "verified" && !(vendor.invoice_sender_emails || []).length) {
        return res.status(409).json({
          error: "Add at least one verified invoice sender email before enabling this vendor for payment"
        });
      }

      let revocationWarning = null;
      if (business.policy_contract_status === "ready" && business.policy_contract_address) {
        if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
          return res.status(409).json({
            error: "Mainnet vendor-policy changes require explicit confirmation",
            confirmation: {
              network: "Arc Mainnet",
              vendor: vendor.name,
              recipientAddress: vendor.recipient_address,
              status
            }
          });
        }
        const revocationSupported = status === "verified" || await readVendorRevocationSupported(
            business.policy_contract_address,
            business.wallet_blockchain
          );
        if (status !== "verified" && !revocationSupported) {
          revocationWarning = revocationSupported === false
            ? "Vendor blocked in InboxPay. This policy vault cannot clear its onchain registration; onchain vendor revocation requires a policy-vault migration."
            : "Vendor blocked in InboxPay. InboxPay could not confirm this vault's onchain revocation capability; no revocation transaction was submitted.";
        }
        if (!revocationWarning) {
          const vendorId = keccak256(new TextEncoder().encode("vendor:" + vendor.name));
          const recipient = status === "verified" ? vendor.recipient_address : ZERO_ADDRESS;
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: business.policy_contract_address,
            abiFunctionSignature: "setVendor(bytes32,address)",
            abiParameters: [vendorId, recipient],
            blockchain: business.wallet_blockchain
          });
          await supabaseRest("audit_events", {
            token: getSupabaseServerSecret(),
            method: "POST",
            body: {
              user_id: user.id,
              business_id: business.id,
              network: business.wallet_blockchain,
              event_type: "vendor_policy_updated",
              actor: "user",
              data: { vendor: vendor.name, status, tx_hash: tx.txHash }
            }
          });
        }
      }

      const rows = await supabaseRest(
        "vendors?id=eq." + encodeURIComponent(id) + "&business_id=eq." + encodeURIComponent(business.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain),
        { token, method: "PATCH", body: { status, updated_at: new Date().toISOString() } }
      );
      return res.status(200).json({
        vendor: rows?.[0] || { ...vendor, status },
        warning: revocationWarning,
        onchainRevoked: revocationWarning ? false : null
      });
    }

    if (req.method === "POST") {
      if (String(req.body?.network || "") !== business.wallet_blockchain) {
        return res.status(409).json({ error: "The active vendor environment changed. Refresh and try again." });
      }
      const name = String(req.body?.name || "").trim();
      const recipientAddress = String(req.body?.recipientAddress || "").trim();
      const currency = String(req.body?.currency || "USDC").toUpperCase();
      const requestedSenderEmails = Array.isArray(req.body?.senderEmails) ? req.body.senderEmails : [];
      const senderEmails = normalizeVendorEmails(requestedSenderEmails);

      if (!name || !/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        return res.status(400).json({ error: "Vendor name and valid EVM recipient address are required" });
      }
      if (currency !== "USDC") {
        return res.status(400).json({ error: "InboxPay currently settles vendor invoices in USDC" });
      }
      if (requestedSenderEmails.length > 5 || senderEmails.length !== requestedSenderEmails.length) {
        return res.status(400).json({ error: "Provide up to five valid, unique invoice sender emails" });
      }

      const rows = await supabaseRest("vendors", {
        token,
        method: "POST",
        body: {
          business_id: business.id,
          network: business.wallet_blockchain,
          name,
          recipient_address: recipientAddress,
          currency,
          invoice_sender_emails: senderEmails,
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
