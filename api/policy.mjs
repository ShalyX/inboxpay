import { parseAbi } from "viem";
import { requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { deployBusinessPolicyVault, getBusinessPolicyVault, getWalletTransaction } from "../lib/policy-contract.mjs";
import { policyClient, writePolicy } from "../lib/policy-sync.mjs";

const USDC = "0x3600000000000000000000000000000000000000";
const maxUint256 = (1n << 256n) - 1n;
const allowedNumbers = new Set(["max_transaction_usdc","daily_limit_usdc","cash_floor_usdc"]);

async function getPolicy(token, businessId) {
  const rows = await supabaseRest(
    "policies?select=*&business_id=eq." + encodeURIComponent(businessId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

async function audit(token, values) {
  await supabaseRest("audit_events", { token, method: "POST", body: values });
}

async function statusHandler(token, user, business) {
  if (!business.policy_contract_id) return { status: "not_deployed", business, contract: null, transaction: null, allowance: null };

  let contract = null;
  let transaction = null;
  try {
    contract = await getBusinessPolicyVault(business.policy_contract_id, business.wallet_blockchain);
    if (business.policy_contract_tx_id) transaction = await getWalletTransaction(business.policy_contract_tx_id, business.wallet_blockchain);
  } catch (error) {
    return {
      status: business.policy_contract_status,
      business,
      error: error instanceof Error ? error.message : String(error),
      contract: null,
      transaction: null,
      allowance: null
    };
  }

  const address = contract?.contractAddress || contract?.address || null;
  let allowance = null;
  if (address && business.wallet_address) {
    try {
      const client = policyClient(business.wallet_blockchain);
      allowance = await client.readContract({
        address: USDC,
        abi: parseAbi(["function allowance(address owner,address spender) view returns (uint256)"]),
        functionName: "allowance",
        args: [business.wallet_address, address]
      });
    } catch {}
  }

  let status = business.policy_contract_status;
  const deploymentStatus = contract?.deploymentStatus || "UNKNOWN";
  const patch = {};
  if (deploymentStatus === "COMPLETE" && address) status = "ready";
  else if (deploymentStatus === "FAILED") status = "error";
  if (status !== business.policy_contract_status) patch.policy_contract_status = status;
  if (address && address !== business.policy_contract_address) patch.policy_contract_address = address;
  if (transaction?.state === "FAILED") {
    patch.policy_contract_status = "error";
    patch.policy_contract_error = transaction.errorDetails || transaction.errorReason || "Policy vault deployment failed";
  }

  let updatedBusiness = business;
  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const updated = await supabaseRest(
      "businesses?id=eq." + encodeURIComponent(business.id),
      { token, method: "PATCH", body: patch }
    );
    updatedBusiness = updated?.[0] || { ...business, ...patch };
  }

  return {
    status: updatedBusiness.policy_contract_status,
    business: updatedBusiness,
    contract,
    transaction,
    allowance: allowance === null ? null : String(allowance)
  };
}

export default async function handler(req, res) {
  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });

    if (req.method === "GET") {
      if (req.query?.view === "status") {
        return res.status(200).json(await statusHandler(token, user, business));
      }
      const policy = await getPolicy(token, business.id);
      return res.status(200).json({ policy });
    }

    if (req.method === "PATCH") {
      const policy = await getPolicy(token, business.id);
      if (!policy) return res.status(404).json({ error: "Business policy not found" });

      const updates = {};
      for (const [key, value] of Object.entries(req.body || {})) {
        if (allowedNumbers.has(key)) {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) return res.status(400).json({ error: key + " must be a non-negative number" });
          updates[key] = number;
        }
      }
      if (typeof req.body?.requireVerifiedVendor === "boolean") updates.require_verified_vendor = req.body.requireVerifiedVendor;
      if (typeof req.body?.paused === "boolean") updates.paused = req.body.paused;

      const maxTx = updates.max_transaction_usdc ?? Number(policy.max_transaction_usdc);
      const daily = updates.daily_limit_usdc ?? Number(policy.daily_limit_usdc);
      const floor = updates.cash_floor_usdc ?? Number(policy.cash_floor_usdc);
      if (maxTx > daily) return res.status(400).json({ error: "Per-payment limit cannot exceed the daily limit" });

      if (business.policy_contract_status === "ready" && business.policy_contract_address) {
        if ("max_transaction_usdc" in updates || "daily_limit_usdc" in updates || "cash_floor_usdc" in updates) {
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: business.policy_contract_address,
            abiFunctionSignature: "setPolicy(uint256,uint256,uint256)",
            abiParameters: [String(Math.round(maxTx * 1e6)), String(Math.round(daily * 1e6)), String(Math.round(floor * 1e6))],
            blockchain: business.wallet_blockchain
          });
          await audit(token, {
            user_id: user.id,
            business_id: business.id,
            event_type: "policy_updated_onchain",
            actor: "user",
            data: { tx_hash: tx.txHash, max_transaction_usdc: maxTx, daily_limit_usdc: daily, cash_floor_usdc: floor }
          });
        }

        if ("paused" in updates) {
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: business.policy_contract_address,
            abiFunctionSignature: "setPaused(bool)",
            abiParameters: [Boolean(updates.paused)],
            blockchain: business.wallet_blockchain
          });
          await audit(token, {
            user_id: user.id,
            business_id: business.id,
            event_type: "policy_pause_updated",
            actor: "user",
            data: { tx_hash: tx.txHash, paused: Boolean(updates.paused) }
          });
        }
      }

      updates.updated_at = new Date().toISOString();
      const rows = await supabaseRest(
        "policies?id=eq." + encodeURIComponent(policy.id),
        { token, method: "PATCH", body: updates }
      );
      return res.status(200).json({ policy: rows?.[0] || { ...policy, ...updates } });
    }

    if (req.method === "POST") {
      const action = String(req.body?.action || "");

      if (action === "deploy") {
        if (!business.wallet_id || !business.wallet_address) return res.status(409).json({ error: "Dedicated business wallet is not ready" });
        if (business.policy_contract_status === "ready" && business.policy_contract_address) return res.status(200).json({ business });

        const policy = await getPolicy(token, business.id);
        if (!policy) throw new Error("Business payment policy is not configured");

        if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
          return res.status(409).json({
            error: "Mainnet policy vault deployment requires explicit confirmation",
            confirmation: { network: "Arc Mainnet", wallet: business.wallet_address, token: "USDC" }
          });
        }

        await supabaseRest("businesses?id=eq." + encodeURIComponent(business.id), {
          token, method: "PATCH",
          body: { policy_contract_status: "deploying", policy_contract_error: null, policy_contract_blockchain: business.wallet_blockchain, updated_at: new Date().toISOString() }
        });

        const deployment = await deployBusinessPolicyVault({
          businessId: business.id,
          walletId: business.wallet_id,
          walletAddress: business.wallet_address,
          maxTransaction: policy.max_transaction_usdc,
          dailyLimit: policy.daily_limit_usdc,
          cashFloor: policy.cash_floor_usdc,
          blockchain: business.wallet_blockchain
        });

        const updated = await supabaseRest("businesses?id=eq." + encodeURIComponent(business.id), {
          token, method: "PATCH",
          body: {
            policy_contract_id: deployment.contractId,
            policy_contract_tx_id: deployment.transactionId,
            policy_contract_blockchain: deployment.blockchain,
            policy_contract_status: "deploying",
            updated_at: new Date().toISOString()
          }
        });
        return res.status(202).json({ business: updated?.[0] || { ...business, ...deployment, policy_contract_status: "deploying" }, deployment });
      }

      if (action === "approve") {
        if (!business.wallet_id || !business.wallet_address || !business.policy_contract_address || business.policy_contract_status !== "ready") {
          return res.status(409).json({ error: "Onchain policy vault is not ready" });
        }

        if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
          return res.status(409).json({
            error: "USDC approval on Arc Mainnet requires explicit confirmation",
            confirmation: {
              network: "Arc Mainnet",
              token: "USDC",
              owner: business.wallet_address,
              spender: business.policy_contract_address
            }
          });
        }

        const client = policyClient(business.wallet_blockchain);
        const current = await client.readContract({
          address: USDC,
          abi: parseAbi(["function allowance(address owner,address spender) view returns (uint256)"]),
          functionName: "allowance",
          args: [business.wallet_address, business.policy_contract_address]
        });

        if (current < maxUint256 / 2n) {
          const tx = await writePolicy({
            walletId: business.wallet_id,
            contractAddress: USDC,
            abiFunctionSignature: "approve(address,uint256)",
            abiParameters: [business.policy_contract_address, String(maxUint256)],
            blockchain: business.wallet_blockchain
          });

          await audit(token, {
            user_id: user.id,
            business_id: business.id,
            event_type: "policy_allowance_approved",
            actor: "user",
            data: { approval_tx_hash: tx.txHash, owner_wallet: business.wallet_address, policy_vault: business.policy_contract_address }
          });

          return res.status(200).json({ ok: true, status: "approved", approvalTxHash: tx.txHash });
        }

        return res.status(200).json({ ok: true, status: "already_approved", approvalTxHash: null });
      }

      return res.status(400).json({ error: "Unknown policy action" });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Policy request failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : 400).json({ error: message });
  }
}
