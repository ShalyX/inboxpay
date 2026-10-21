import { rejectPreviewRequest, isReadOnlyPreview } from "../lib/preview-boundary.mjs";
import { parseAbi, formatUnits } from "viem";
import { getSupabaseServerSecret, requireUser, supabaseRest } from "../lib/supabase-server.mjs";
import { getBusiness } from "../lib/businesses.mjs";
import { policyClient } from "../lib/policy-sync.mjs";
import { requestBusinessTestnetFunds } from "../lib/circle-wallets.mjs";
import { requestWalletWithdrawal, walletWithdrawalState } from "../lib/wallet-withdrawals.mjs";

const USDC = "0x3600000000000000000000000000000000000000";

export default async function handler(req, res) {
  if (rejectPreviewRequest(req, res)) return;
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
      if (String(req.body?.network || "") !== business.wallet_blockchain) {
        return res.status(409).json({ error: "The active wallet environment changed. Refresh and try again." });
      }
      if (req.body?.action === "withdraw") {
        const recipientAddress = String(req.body?.recipientAddress || "").trim();
        const amount = String(req.body?.amount || "").trim();
        if (req.body?.confirmWithdrawal !== true) {
          return res.status(409).json({
            error: "Wallet withdrawal requires explicit confirmation",
            confirmation: {
              network: business.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet",
              token: "USDC",
              amount,
              recipientAddress,
              walletAddress: business.wallet_address
            }
          });
        }
        if (business.wallet_blockchain === "ARC" && req.body?.confirmMainnet !== true) {
          return res.status(409).json({ error: "Arc Mainnet withdrawal requires explicit Mainnet confirmation" });
        }
        const result = await requestWalletWithdrawal(token, user.id, {
          requestId: req.body?.requestId,
          network: req.body?.network,
          recipientAddress,
          amount
        });
        return res.status(result.withdrawal?.status === "confirmed" ? 200 : 202).json({ ok: true, ...result });
      }
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
          token: getSupabaseServerSecret(),
          method: "POST",
          body: {
            user_id: user.id,
            business_id: business.id,
              network: business.wallet_blockchain,
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

    const state = await walletWithdrawalState(token, user.id, business, { reconcile: !isReadOnlyPreview() });
    const balance = state.balance;

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
      cashFloor: formatUnits(state.cashFloor, 6),
      reserved: formatUnits(state.reserved, 6),
      withdrawable: formatUnits(state.withdrawable, 6),
      policyVaultAddress: business.policy_contract_address || null,
      policyVaultBalance: policyVaultBalance === null ? null : formatUnits(policyVaultBalance, 6),
      policyVaultCustody: "allowance_only",
      withdrawals: state.withdrawals.map((withdrawal) => ({
        id: withdrawal.id,
        requestId: withdrawal.request_id,
        amount: String(withdrawal.amount_usdc),
        recipientAddress: withdrawal.recipient_address,
        network: withdrawal.network,
        status: withdrawal.status,
        circleTransactionId: withdrawal.circle_transaction_id,
        transactionHash: withdrawal.transaction_hash,
        error: withdrawal.error,
        createdAt: withdrawal.created_at,
        updatedAt: withdrawal.updated_at,
        confirmedAt: withdrawal.confirmed_at
      }))
    });
  } catch (error) {
    console.error("InboxPay wallet balance failed:", error);
    const message = error instanceof Error ? error.message : "Wallet unavailable";
    const status = /Authentication required|Invalid or expired/i.test(message)
      ? 401
      : /amount|recipient|request ID|different from/i.test(message)
        ? 400
        : /not ready|not provisioned|environment changed|exceeds available|cash floor|withdrawal.*processing|withdrawal.*failed|withdrawal.*review/i.test(message)
          ? 409
          : 500;
    return res.status(status).json({ error: status === 500 ? "Wallet operation is temporarily unavailable" : message });
  }
}
