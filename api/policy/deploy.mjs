import { requireUser, supabaseRest } from "../../lib/supabase-server.mjs";
import { getBusiness } from "../../lib/business-data.mjs";
import { deployBusinessPolicyVault } from "../../lib/policy-contract.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    if (!business.wallet_id || !business.wallet_address) {
      return res.status(409).json({ error: "Dedicated business wallet is not ready" });
    }
    if (business.policy_contract_status === "ready" && business.policy_contract_address) {
      return res.status(200).json({ business });
    }
    if (business.policy_contract_status === "deploying") {
      return res.status(202).json({ business, message: "Policy vault deployment is already in progress" });
    }

    const policies = await supabaseRest(
      "policies?select=max_transaction_usdc,daily_limit_usdc,cash_floor_usdc&business_id=eq." +
        encodeURIComponent(business.id) + "&limit=1",
      { token }
    );
    const policy = policies?.[0];
    if (!policy) throw new Error("Business payment policy is not configured");

    if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
      return res.status(409).json({
        error: "Mainnet policy vault deployment requires explicit confirmation",
        confirmation: {
          network: "Arc Mainnet",
          wallet: business.wallet_address,
          token: "USDC"
        }
      });
    }

    await supabaseRest(
      "businesses?id=eq." + encodeURIComponent(business.id),
      {
        token,
        method: "PATCH",
        body: {
          policy_contract_status: "deploying",
          policy_contract_error: null,
          policy_contract_blockchain: business.wallet_blockchain,
          updated_at: new Date().toISOString()
        }
      }
    );

    try {
      const deployment = await deployBusinessPolicyVault({
        walletId: business.wallet_id,
        walletAddress: business.wallet_address,
        maxTransaction: policy.max_transaction_usdc,
        dailyLimit: policy.daily_limit_usdc,
        cashFloor: policy.cash_floor_usdc
      });

      const updated = await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id),
        {
          token,
          method: "PATCH",
          body: {
            policy_contract_id: deployment.contractId,
            policy_contract_tx_id: deployment.transactionId,
            policy_contract_blockchain: deployment.blockchain,
            policy_contract_status: "deploying",
            updated_at: new Date().toISOString()
          }
        }
      );

      return res.status(202).json({
        business: updated?.[0] || { ...business, ...deployment, policy_contract_status: "deploying" },
        deployment
      });
    } catch (deploymentError) {
      await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id),
        {
          token,
          method: "PATCH",
          body: {
            policy_contract_status: "error",
            policy_contract_error: deploymentError instanceof Error ? deploymentError.message : String(deploymentError),
            updated_at: new Date().toISOString()
          }
        }
      ).catch(() => {});
      throw deploymentError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Policy vault deployment failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 400).json({ error: message });
  }
}
