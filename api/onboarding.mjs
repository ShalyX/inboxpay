import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { normalizeBusinessName } from "../lib/business-profile.mjs";
import { assertSupportedNetwork } from "../lib/business-networks.mjs";
import {
  ensureBusinessNetworkAccount,
  getBusiness,
  getBusinessRecord,
  updateBusinessNetworkAccount
} from "../lib/businesses.mjs";

function slugify(value) {
  const slug = String(value || "business").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "business";
}

async function findBusiness(token, userId) {
  return getBusinessRecord(token, userId);
}

async function ensureBusiness(token, user) {
  const existing = await findBusiness(token, user.id);
  if (existing) return existing;

  const name = String(user.user_metadata?.business_name || user.email?.split("@")[1] || "My Business").trim() || "My Business";

  try {
    const created = await supabaseRest("businesses", {
      token,
      method: "POST",
      body: {
        owner_user_id: user.id,
        name,
        slug: slugify(name) + "-" + user.id.slice(0, 8)
      }
    });
    return created?.[0] || null;
  } catch (error) {
    // Another bootstrap request can win the unique owner_user_id insert.
    // Treat that conflict as success and load the business that now exists.
    if (error instanceof Error && /^Supabase 409:/i.test(error.message)) {
      return findBusiness(token, user.id);
    }
    throw error;
  }
}

async function ensurePolicy(token, userId, businessId, network) {
  const policies = await supabaseRest(
    "policies?select=*&business_id=eq." + encodeURIComponent(businessId) +
      "&network=eq." + encodeURIComponent(network) + "&limit=1",
    { token }
  );
  if (policies?.[0]) return policies[0];

  try {
    const created = await supabaseRest("policies", {
      token,
      method: "POST",
      body: {
        user_id: userId,
        business_id: businessId,
        network,
        max_transaction_usdc: 1000,
        daily_limit_usdc: 5000,
        cash_floor_usdc: 20,
        require_verified_vendor: true,
        paused: false
      }
    });
    return created?.[0] || null;
  } catch (error) {
    // Same idempotency rule for concurrent policy initialization.
    if (error instanceof Error && /^Supabase 409:/i.test(error.message)) {
      const rows = await supabaseRest(
        "policies?select=*&business_id=eq." + encodeURIComponent(businessId) +
          "&network=eq." + encodeURIComponent(network) + "&limit=1",
        { token }
      );
      return rows?.[0] || null;
    }
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);

    if (req.body?.action === "rename_business") {
      const business = await findBusiness(token, user.id);
      if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
      let name;
      try {
        name = normalizeBusinessName(req.body?.name);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      const rows = await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id) + "&owner_user_id=eq." + encodeURIComponent(user.id),
        {
          token,
          method: "PATCH",
          body: { name, updated_at: new Date().toISOString() }
        }
      );
      const updatedBusiness = await getBusiness(token, user.id) || rows?.[0] || { ...business, name };
      await supabaseRest("audit_events", {
        token,
        method: "POST",
        body: {
          user_id: user.id,
          business_id: business.id,
          network: business.active_network || business.wallet_blockchain || "ARC-TESTNET",
          event_type: "business_profile_updated",
          actor: "user",
          data: { field: "name" }
        }
      }).catch((error) => console.error("InboxPay business profile audit failed", { businessId: business.id, message: error.message }));
      return res.status(200).json({ business: updatedBusiness });
    }

    if (req.body?.action === "select_network") {
      const business = await findBusiness(token, user.id);
      if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
      let network;
      try {
        network = assertSupportedNetwork(req.body?.network);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      if (network === "ARC" && req.body?.confirmMainnet !== true) {
        return res.status(409).json({
          error: "Entering the Arc Mainnet environment requires explicit confirmation",
          confirmation: {
            network: "Arc Mainnet",
            purpose: "View and operate this business's isolated live-payment environment"
          }
        });
      }

      await ensureBusinessNetworkAccount(token, business, network);
      await ensurePolicy(token, user.id, business.id, network);
      await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id) + "&owner_user_id=eq." + encodeURIComponent(user.id),
        {
          token,
          method: "PATCH",
          body: { active_network: network, updated_at: new Date().toISOString() }
        }
      );
      await supabaseRest("audit_events", {
        token,
        method: "POST",
        body: {
          user_id: user.id,
          business_id: business.id,
          network,
          event_type: "business_network_selected",
          actor: "user",
          data: { network }
        }
      });
      return res.status(200).json({ business: await getBusiness(token, user.id) });
    }

    if (req.body?.action === "provision_wallet") {
      const business = await findBusiness(token, user.id);
      if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
      let network;
      try {
        network = assertSupportedNetwork(req.body?.network || business.active_network || "ARC-TESTNET");
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      if (network === "ARC" && req.body?.confirmMainnet !== true) {
        return res.status(409).json({
          error: "Dedicated Circle wallet creation on Arc Mainnet requires explicit confirmation",
          confirmation: {
            network: "Arc Mainnet",
            wallet: null,
            purpose: "Create the business's dedicated USDC wallet for live payments"
          }
        });
      }

      const account = await ensureBusinessNetworkAccount(token, business, network);
      await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id) + "&owner_user_id=eq." + encodeURIComponent(user.id), {
        token,
        method: "PATCH",
        body: { active_network: network, updated_at: new Date().toISOString() }
      });
      if (account?.wallet_id) return res.status(200).json({ business: await getBusiness(token, user.id) });

      await updateBusinessNetworkAccount(token, business.id, network, {
        wallet_status: "provisioning",
        wallet_blockchain: network,
        wallet_error: null
      });

      try {
        const { createBusinessWallet } = await import("../lib/circle-wallets.mjs");
        const wallet = await createBusinessWallet(business.id, business.name, network);
        const walletRecord = {
          wallet_set_id: wallet.walletSetId,
          wallet_id: wallet.walletId,
          wallet_address: wallet.walletAddress,
          wallet_blockchain: wallet.walletBlockchain
        };
        await updateBusinessNetworkAccount(token, business.id, network, {
          ...walletRecord,
          wallet_status: "ready",
          wallet_error: null
        });
        await ensurePolicy(token, user.id, business.id, network);
        return res.status(200).json({ business: await getBusiness(token, user.id) });
      } catch (walletError) {
        await updateBusinessNetworkAccount(token, business.id, network, {
          wallet_status: "error",
          wallet_error: walletError instanceof Error ? walletError.message : String(walletError)
        }).catch(() => {});
        throw walletError;
      }
    }

    const business = await ensureBusiness(token, user);
    if (!business) throw new Error("Unable to create or load InboxPay business");

    const network = assertSupportedNetwork(business.active_network || business.wallet_blockchain || "ARC-TESTNET");
    await ensureBusinessNetworkAccount(token, business, network);
    const policy = await ensurePolicy(token, user.id, business.id, network);
    if (!policy) throw new Error("Unable to create or load InboxPay policy");
    const projectedBusiness = await getBusiness(token, user.id);

    // Wallet creation is a separate explicit business action.
    // This avoids silently creating mainnet state during account sign-in.

    return res.status(200).json({
      business: projectedBusiness,
      onboarding: {
        walletRequired: !projectedBusiness?.wallet_id,
        gmailRequired: true,
        policyVaultRequired: !projectedBusiness?.policy_contract_address
      }
    });
  } catch (error) {
    console.error("InboxPay onboarding failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Onboarding failed"
    });
  }
}
