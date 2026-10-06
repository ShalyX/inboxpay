import { parseAbi, formatUnits } from "viem";
import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { policyClient } from "../lib/policy-sync.mjs";
import { requestBusinessTestnetFunds } from "../lib/circle-wallets.mjs";

const USDC = "0x3600000000000000000000000000000000000000";

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business?.wallet_address) {
      return res.status(409).json({ error: "Business wallet is not provisioned yet" });
    }

    if (req.method === "POST") {
      if (req.body?.action !== "fund_testnet") {
        return res.status(400).json({ error: "Unsupported wallet action" });
      }
      if (business.wallet_blockchain !== "ARC-TESTNET") {
        return res.status(409).json({ error: "Testnet funding is not available for mainnet wallets" });
      }

      const client = policyClient(business.wallet_blockchain);
      const currentBalance = await client.readContract({
        address: USDC,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [business.wallet_address]
      });
      if (currentBalance > 0n) {
        return res.status(200).json({ ok: true, status: "already_funded", balance: formatUnits(currentBalance, 6) });
      }

      await requestBusinessTestnetFunds(business.wallet_address, business.wallet_blockchain);
      let auditRecorded = true;
      try {
        await supabaseRest("audit_events", {
          token,
          method: "POST",
          body: {
            user_id: user.id,
            business_id: business.id,
            event_type: "testnet_wallet_funding_requested",
            actor: "user",
            data: {
              wallet_address: business.wallet_address,
              blockchain: business.wallet_blockchain
            }
          }
        });
      } catch (error) {
        auditRecorded = false;
        console.error("InboxPay testnet funding audit failed:", error instanceof Error ? error.message : error);
      }
      return res.status(202).json({ ok: true, status: "requested", auditRecorded });
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
