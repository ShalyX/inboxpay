import { requireUser, supabaseRest } from "../../lib/supabase-server.mjs";
import { getBusiness } from "../../lib/business-data.mjs";
import { getBusinessPolicyVault, getWalletTransaction } from "../../lib/policy-contract.mjs";
import { policyClient } from "../../lib/policy-sync.mjs";
import { parseAbi } from "viem";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });

    if (!business.policy_contract_id) {
      return res.status(200).json({ status: "not_deployed", business });
    }

    let contract = null;
    let transaction = null;
    try {
      contract = await getBusinessPolicyVault(business.policy_contract_id);
      if (business.policy_contract_tx_id) {
        transaction = await getWalletTransaction(business.policy_contract_tx_id);
      }
    } catch (error) {
      return res.status(200).json({
        status: business.policy_contract_status,
        error: error instanceof Error ? error.message : String(error),
        business
      });
    }

    const address = contract?.contractAddress || contract?.address || null;
    let allowance = null;
    if (address && business.wallet_address) {
      try {
        const client = policyClient(business.wallet_blockchain);
        allowance = await client.readContract({
          address: "0x3600000000000000000000000000000000000000",
          abi: parseAbi(["function allowance(address owner,address spender) view returns (uint256)"]),
          functionName: "allowance",
          args: [business.wallet_address, address]
        });
      } catch {}
    }
    const deploymentStatus = contract?.deploymentStatus || "UNKNOWN";
    let status = business.policy_contract_status;

    if (deploymentStatus === "COMPLETE" && address) status = "ready";
    else if (deploymentStatus === "FAILED") status = "error";

    const patch = {};
    if (status !== business.policy_contract_status) patch.policy_contract_status = status;
    if (address && address !== business.policy_contract_address) patch.policy_contract_address = address;
    if (transaction?.state && transaction.state === "FAILED") {
      patch.policy_contract_status = "error";
      patch.policy_contract_error = transaction.errorDetails || transaction.errorReason || "Policy vault deployment failed";
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const updated = await supabaseRest(
        "businesses?id=eq." + encodeURIComponent(business.id),
        { token, method: "PATCH", body: patch }
      );
      return res.status(200).json({
        status: patch.policy_contract_status || status,
        business: updated?.[0] || { ...business, ...patch },
        contract,
        transaction
      });
    }

    return res.status(200).json({
      status,
      business,
      contract,
      transaction,
      allowance: allowance === null ? null : String(allowance)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Policy status unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
