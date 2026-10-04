import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";

function slugify(value) {
  const slug = String(value || "business").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "business";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);

    if (req.body?.action === "provision_wallet") {
      const businessRows = await supabaseRest(
        "businesses?select=*&owner_user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
        { token }
      );
      const business = businessRows?.[0];
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
            wallet: business.wallet_address || null,
            purpose: "Create the business's dedicated USDC wallet for live payments"
          }
        });
      }

      await supabaseRest("businesses?id=eq." + encodeURIComponent(business.id), {
        token,
        method: "PATCH",
        body: {
          wallet_status: "provisioning",
          wallet_blockchain: network,
          wallet_error: null,
          updated_at: new Date().toISOString()
        }
      });

      try {
        const { createBusinessWallet } = await import("../lib/circle-wallets.mjs");
        const wallet = await createBusinessWallet(business.id, business.name, network);
        const updated = await supabaseRest("businesses?id=eq." + encodeURIComponent(business.id), {
          token,
          method: "PATCH",
          body: {
            ...wallet,
            wallet_status: "ready",
            wallet_error: null,
            updated_at: new Date().toISOString()
          }
        });
        return res.status(200).json({ business: updated?.[0] || { ...business, ...wallet, wallet_status: "ready" } });
      } catch (walletError) {
        await supabaseRest("businesses?id=eq." + encodeURIComponent(business.id), {
          token,
          method: "PATCH",
          body: {
            wallet_status: "error",
            wallet_error: walletError instanceof Error ? walletError.message : String(walletError),
            updated_at: new Date().toISOString()
          }
        }).catch(() => {});
        throw walletError;
      }
    }

    const requestedName = String(req.body?.businessName || "").trim();
    const name = requestedName || user.user_metadata?.business_name || user.email?.split("@")[1] || "My Business";

    const existing = await supabaseRest(
      "businesses?select=*&owner_user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
      { token }
    );

    let business = existing?.[0];
    if (!business) {
      const created = await supabaseRest("businesses", {
        token,
        method: "POST",
        body: {
          owner_user_id: user.id,
          name,
          slug: slugify(name) + "-" + user.id.slice(0, 8)
        }
      });
      business = created?.[0];
    }

    if (!business) throw new Error("Unable to create InboxPay business");

    // Wallet creation is a separate explicit business action.
    // This avoids silently creating mainnet state during account sign-in.


    const policies = await supabaseRest(
      "policies?select=*&user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
      { token }
    );
    if (!policies?.[0]) {
      await supabaseRest("policies", {
        token,
        method: "POST",
        body: {
          user_id: user.id,
          business_id: business.id,
          max_transaction_usdc: 1000,
          daily_limit_usdc: 5000,
          cash_floor_usdc: 20,
          require_verified_vendor: true,
          paused: false
        }
      });
    }

    return res.status(200).json({
      business,
      onboarding: {
        walletRequired: !business.wallet_id,
        gmailRequired: true,
        policyVaultRequired: !business.policy_contract_address
      }
    });
  } catch (error) {
    console.error("InboxPay onboarding failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Onboarding failed"
    });
  }
}
