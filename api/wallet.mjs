import { parseAbi, formatUnits } from "viem";
import { requireUser } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { policyClient } from "../lib/policy-sync.mjs";

const USDC = "0x3600000000000000000000000000000000000000";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business?.wallet_address) {
      return res.status(409).json({ error: "Business wallet is not provisioned yet" });
    }

    const client = policyClient(business.wallet_blockchain);
    const balance = await client.readContract({
      address: USDC,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [business.wallet_address]
    });

    let policyVaultBalance = null;
    if (business.policy_contract_address) {
      try {
        policyVaultBalance = await client.readContract({
          address: business.policy_contract_address,
          abi: parseAbi(["function vaultBalance() view returns (uint256)"]),
          functionName: "vaultBalance"
        });
      } catch {}
    }

    return res.status(200).json({
      address: business.wallet_address,
      blockchain: business.wallet_blockchain,
      currency: "USDC",
      balance: formatUnits(balance, 6),
      policyVaultAddress: business.policy_contract_address || null,
      policyVaultBalance: policyVaultBalance === null ? null : formatUnits(policyVaultBalance, 6)
    });
  } catch (error) {
    console.error("InboxPay wallet balance failed:", error);
    const message = error instanceof Error ? error.message : "Wallet unavailable";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 500).json({ error: message });
  }
}
