import { requireUser, supabaseRest } from "../../lib/supabase-server.mjs";
import { getBusiness } from "../../lib/business-data.mjs";
import { policyClient, writePolicy } from "../../lib/policy-sync.mjs";
import { parseAbi, formatUnits } from "viem";

const USDC = "0x3600000000000000000000000000000000000000";
const maxUint256 = (1n << 256n) - 1n;
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business?.wallet_id || !business.wallet_address) {
      return res.status(409).json({ error: "Business wallet is not ready" });
    }
    if (!business.policy_contract_address || business.policy_contract_status !== "ready") {
      return res.status(409).json({ error: "Onchain policy vault is not ready" });
    }

    if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
      return res.status(409).json({
        error: "USDC approval on Arc Mainnet requires explicit confirmation",
        confirmation: {
          network: "Arc Mainnet",
          token: "USDC",
          owner: business.wallet_address,
          spender: business.policy_contract_address,
          purpose: "Allow InboxPay's policy vault to move only payments that satisfy the business policy"
        }
      });
    }

    const client = policyClient(business.wallet_blockchain);
    const current = await client.readContract({
      address: USDC,
      abi: tokenAbi,
      functionName: "allowance",
      args: [business.wallet_address, business.policy_contract_address]
    });

    if (current >= maxUint256 / 2n) {
      return res.status(200).json({
        ok: true,
        status: "already_approved",
        allowance: String(current),
        approvalTxHash: null
      });
    }

    const tx = await writePolicy({
      walletId: business.wallet_id,
      contractAddress: USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [business.policy_contract_address, String(maxUint256)]
    });

    const after = await client.readContract({
      address: USDC,
      abi: tokenAbi,
      functionName: "allowance",
      args: [business.wallet_address, business.policy_contract_address]
    });
    if (after < maxUint256 / 2n) throw new Error("USDC approval confirmed but allowance reconciliation failed");

    await supabaseRest("audit_events", {
      token,
      method: "POST",
      body: {
        user_id: user.id,
        business_id: business.id,
        event_type: "policy_allowance_approved",
        actor: "user",
        data: {
          approval_tx_hash: tx.txHash,
          owner_wallet: business.wallet_address,
          policy_vault: business.policy_contract_address,
          allowance_after: String(after)
        }
      }
    });

    return res.status(200).json({
      ok: true,
      status: "approved",
      allowance: String(after),
      approvalTxHash: tx.txHash
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "USDC approval failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 400).json({ ok: false, error: message });
  }
}
