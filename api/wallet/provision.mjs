import { requireUser, supabaseRest } from "../../lib/supabase-server.mjs";
import { getBusiness } from "../../lib/business-data.mjs";
import { createBusinessWallet } from "../../lib/circle-wallets.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    if (business.wallet_id) return res.status(200).json({ business });

    const network = String(req.body?.network || "ARC-TESTNET");
    if (!["ARC-TESTNET", "ARC"].includes(network)) {
      return res.status(400).json({ error: "InboxPay supports Arc Testnet and Arc Mainnet" });
    }

    if (network === "ARC" && req.body?.confirmMainnet !== true) {
      return res.status(409).json({
        error: "Dedicated Circle wallet creation on Arc Mainnet requires explicit confirmation",
        confirmation: {
          network: "Arc Mainnet",
          purpose: "Create the business's dedicated USDC wallet for live payments"
        }
      });
    }

    await supabaseRest(
      "businesses?id=eq." + encodeURIComponent(business.id),
      {
        token,
        method: "PATCH",
        body: {
          wallet_status: "provisioning",
          wallet_blockchain: network,
          wallet_error: null,
          updated_at: new Date().toISOString()
        }
      }
    );

    try {
      const wallet = await createBusinessWallet(business.id, business.name, network);
      const updated = await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id),
        {
          token,
          method: "PATCH",
          body: {
            ...wallet,
            wallet_status: "ready",
            wallet_error: null,
            updated_at: new Date().toISOString()
          }
        }
      );
      return res.status(200).json({ business: updated?.[0] || { ...business, ...wallet, wallet_status: "ready" } });
    } catch (walletError) {
      await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id),
        {
          token,
          method: "PATCH",
          body: {
            wallet_status: "error",
            wallet_error: walletError instanceof Error ? walletError.message : String(walletError),
            updated_at: new Date().toISOString()
          }
        }
      ).catch(() => {});
      throw walletError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet provisioning failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 400).json({ error: message });
  }
}
