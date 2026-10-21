import { decodeEventLog, formatUnits, parseAbi, parseUnits } from "viem";
import { getBusiness } from "./businesses.mjs";
import { estimateBusinessWalletTransfer, submitBusinessWalletTransfer } from "./circle-wallets.mjs";
import { getWalletTransaction } from "./policy-contract.mjs";
import { policyClient, readPolicyState } from "./policy-sync.mjs";
import { getSupabaseServerSecret, supabaseRest } from "./supabase-server.mjs";

const USDC = "0x3600000000000000000000000000000000000000";
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

function parseAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) {
    throw new Error("Withdrawal amount must be a positive USDC amount with no more than 6 decimal places");
  }
  const units = parseUnits(text, 6);
  if (units <= 0n) throw new Error("Withdrawal amount must be greater than zero");
  return { text: formatUnits(units, 6), units };
}

function validAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function feeUnits(value) {
  const fee = Number(value || 0);
  if (!Number.isFinite(fee) || fee < 0) throw new Error("Circle returned an invalid network-fee estimate");
  return BigInt(Math.ceil(fee * 1e6));
}

export function withdrawalAvailability({ balance, cashFloor, reserved, feeReserve = 0n }) {
  const available = balance - cashFloor - reserved - feeReserve;
  return available > 0n ? available : 0n;
}

async function policyFor(token, business) {
  const rows = await supabaseRest(
    "policies?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&network=eq." + encodeURIComponent(business.wallet_blockchain) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

async function walletBalance(business) {
  return policyClient(business.wallet_blockchain).readContract({
    address: USDC,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [business.wallet_address]
  });
}

async function reservedInvoiceFunds(token, business) {
  const jobs = await supabaseRest(
    "invoice_execution_jobs?select=invoice_id,status&business_id=eq." + encodeURIComponent(business.id) +
      "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
      "&status=in.(queued,leased,retry,reconciling)",
    { token }
  ) || [];
  const jobIds = [...new Set(jobs.map((job) => job.invoice_id).filter(Boolean))];
  const base = "invoices?select=id,amount,settlement_status&business_id=eq." + encodeURIComponent(business.id) +
    "&settlement_network=eq." + encodeURIComponent(business.wallet_blockchain);
  const [jobInvoices, processingInvoices] = await Promise.all([
    jobIds.length
      ? supabaseRest(base + "&id=in.(" + jobIds.map(encodeURIComponent).join(",") + ")", { token })
      : [],
    supabaseRest(base + "&settlement_status=eq.processing", { token })
  ]);
  const invoices = [...new Map([...(jobInvoices || []), ...(processingInvoices || [])].map((invoice) => [invoice.id, invoice])).values()];
  return invoices.reduce((total, invoice) => {
    if (invoice.settlement_status === "confirmed") return total;
    try { return total + parseUnits(String(invoice.amount), 6); } catch { return total; }
  }, 0n);
}

async function cashFloor(token, business, policy) {
  if (business.policy_contract_status === "ready" && business.policy_contract_address) {
    const state = await readPolicyState(business.policy_contract_address, business.wallet_blockchain);
    return state.cashFloor;
  }
  return parseUnits(String(policy?.cash_floor_usdc || 0), 6);
}

async function updateWithdrawal(token, withdrawal, patch) {
  const mutationToken = getSupabaseServerSecret();
  const rows = await supabaseRest(
    "wallet_withdrawals?id=eq." + encodeURIComponent(withdrawal.id) +
      "&business_id=eq." + encodeURIComponent(withdrawal.business_id) +
      "&network=eq." + encodeURIComponent(withdrawal.network),
    { token: mutationToken, method: "PATCH", body: { ...patch, updated_at: new Date().toISOString() } }
  );
  return rows?.[0] || { ...withdrawal, ...patch };
}

async function audit(token, withdrawal, eventType, data) {
  const mutationToken = getSupabaseServerSecret();
  await supabaseRest("audit_events", {
    token: mutationToken,
    method: "POST",
    body: {
      user_id: withdrawal.user_id,
      business_id: withdrawal.business_id,
      network: withdrawal.network,
      event_type: eventType,
      actor: eventType === "wallet_withdrawal_requested" ? "user" : "agent",
      data: { withdrawal_id: withdrawal.id, request_id: withdrawal.request_id, ...data }
    }
  });
}

export async function reconcileWithdrawal(token, withdrawal) {
  if (withdrawal.status !== "processing" || !withdrawal.circle_transaction_id) return withdrawal;
  let provider;
  try {
    provider = await getWalletTransaction(withdrawal.circle_transaction_id, withdrawal.network);
  } catch {
    return withdrawal;
  }
  const state = String(provider?.state || "UNKNOWN").toUpperCase();
  if (["FAILED", "DENIED", "CANCELLED", "STUCK"].includes(state)) {
    const failed = await updateWithdrawal(token, withdrawal, {
      status: "failed",
      error: provider?.errorDetails || provider?.errorReason || "Circle withdrawal failed"
    });
    await audit(token, failed, "wallet_withdrawal_failed", {
      circle_transaction_id: withdrawal.circle_transaction_id,
      provider_state: state,
      reason: failed.error
    }).catch(() => {});
    return failed;
  }
  if (state !== "COMPLETE") return withdrawal;
  const txHash = provider.txHash || provider.hash || null;
  if (!txHash) return withdrawal;

  const chain = policyClient(withdrawal.network);
  let receipt;
  let transaction;
  try {
    [receipt, transaction] = await Promise.all([
      chain.getTransactionReceipt({ hash: txHash }),
      chain.getTransaction({ hash: txHash })
    ]);
  } catch {
    return updateWithdrawal(token, withdrawal, { transaction_hash: txHash });
  }

  const expectedAmount = parseUnits(String(withdrawal.amount_usdc), 6);
  const tokenTransferMatches = receipt.status === "success" && receipt.logs.some((log) => {
    if (String(log.address || "").toLowerCase() !== USDC) return false;
    try {
      const decoded = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      return decoded.eventName === "Transfer" &&
        decoded.args.from?.toLowerCase() === withdrawal.wallet_address.toLowerCase() &&
        decoded.args.to?.toLowerCase() === withdrawal.recipient_address.toLowerCase() &&
        decoded.args.value === expectedAmount;
    } catch {
      return false;
    }
  });
  const sourceMatches = transaction.from?.toLowerCase() === withdrawal.wallet_address.toLowerCase();
  const nativeTransferMatches = transaction.to?.toLowerCase() === withdrawal.recipient_address.toLowerCase() &&
    transaction.value === parseUnits(String(withdrawal.amount_usdc), 18);
  const transferMatches = tokenTransferMatches || nativeTransferMatches;
  if (receipt.status !== "success") {
    const failed = await updateWithdrawal(token, withdrawal, { status: "failed", transaction_hash: txHash, error: "Arc withdrawal transaction reverted" });
    await audit(token, failed, "wallet_withdrawal_failed", { tx_hash: txHash, reason: failed.error }).catch(() => {});
    return failed;
  }
  if (!sourceMatches || !transferMatches) {
    const review = await updateWithdrawal(token, withdrawal, {
      status: "review",
      transaction_hash: txHash,
      error: "Arc receipt did not match the authorized withdrawal"
    });
    await audit(token, review, "wallet_withdrawal_reconciliation_review", { tx_hash: txHash, source_matches: sourceMatches, transfer_matches: transferMatches }).catch(() => {});
    return review;
  }

  const confirmed = await updateWithdrawal(token, withdrawal, {
    status: "confirmed",
    transaction_hash: txHash,
    confirmed_at: new Date().toISOString(),
    error: null
  });
  await audit(token, confirmed, "wallet_withdrawal_confirmed", {
    amount_usdc: Number(withdrawal.amount_usdc),
    recipient_address: withdrawal.recipient_address,
    tx_hash: txHash
  });
  return confirmed;
}

async function withdrawalRows(token, business) {
  return await supabaseRest(
    "wallet_withdrawals?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
      "&order=created_at.desc&limit=50",
    { token }
  ) || [];
}

export async function walletWithdrawalState(token, userId, business = null, { reconcile = true } = {}) {
  const selectedBusiness = business || await getBusiness(token, userId);
  if (!selectedBusiness?.wallet_address) throw new Error("Business wallet is not provisioned yet");
  const [policy, balance, reserved, withdrawals] = await Promise.all([
    policyFor(token, selectedBusiness),
    walletBalance(selectedBusiness),
    reservedInvoiceFunds(token, selectedBusiness),
    withdrawalRows(token, selectedBusiness)
  ]);
  const floor = await cashFloor(token, selectedBusiness, policy);
  const reconciled = [];
  for (const withdrawal of withdrawals) reconciled.push(reconcile ? await reconcileWithdrawal(token, withdrawal) : withdrawal);
  return {
    balance,
    cashFloor: floor,
    reserved,
    withdrawable: withdrawalAvailability({ balance, cashFloor: floor, reserved }),
    withdrawals: reconciled
  };
}

export async function requestWalletWithdrawal(token, userId, input) {
  const business = await getBusiness(token, userId);
  if (!business?.wallet_id || !business.wallet_address || business.wallet_status !== "ready") {
    throw new Error("Business wallet is not ready");
  }
  if (String(input.network || "") !== business.wallet_blockchain) {
    throw new Error("The active wallet environment changed. Refresh and confirm again.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input.requestId || ""))) {
    throw new Error("A valid withdrawal request ID is required");
  }
  const recipientAddress = String(input.recipientAddress || "").trim();
  if (!validAddress(recipientAddress) || /^0x0{40}$/i.test(recipientAddress)) throw new Error("A valid non-zero Arc recipient address is required");
  if (recipientAddress.toLowerCase() === business.wallet_address.toLowerCase()) throw new Error("Withdrawal recipient must be different from the business wallet");
  const amount = parseAmount(input.amount);

  const existingRows = await supabaseRest(
    "wallet_withdrawals?select=*&business_id=eq." + encodeURIComponent(business.id) +
      "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
      "&request_id=eq." + encodeURIComponent(input.requestId) + "&limit=1",
    { token }
  );
  let withdrawal = existingRows?.[0] || null;
  let createdWithdrawal = false;
  if (withdrawal) {
    if (
      withdrawal.recipient_address.toLowerCase() !== recipientAddress.toLowerCase() ||
      parseUnits(String(withdrawal.amount_usdc), 6) !== amount.units
    ) {
      throw new Error("Withdrawal request ID is already bound to different transfer details");
    }
    if (withdrawal.status !== "processing" || withdrawal.circle_transaction_id) {
      const reconciled = await reconcileWithdrawal(token, withdrawal);
      if (reconciled.status === "failed") {
        throw new Error(reconciled.error || "The existing withdrawal request failed");
      }
      if (reconciled.status === "review") {
        throw new Error(reconciled.error || "The existing withdrawal requires operator review");
      }
      return { withdrawal: reconciled, idempotent: true };
    }
  }

  if (!withdrawal) {
    try {
      const createdRows = await supabaseRest("rpc/prepare_wallet_withdrawal", {
        token: getSupabaseServerSecret(),
        method: "POST",
        body: {
          p_request_id: input.requestId,
          p_business_id: business.id,
          p_user_id: userId,
          p_network: business.wallet_blockchain,
          p_wallet_id: business.wallet_id,
          p_wallet_address: business.wallet_address,
          p_token_address: USDC,
          p_recipient_address: recipientAddress,
          p_amount_usdc: amount.text
        }
      });
      withdrawal = createdRows?.[0] || null;
      createdWithdrawal = Boolean(withdrawal);
    } catch (error) {
      const raced = await supabaseRest(
        "wallet_withdrawals?select=*&business_id=eq." + encodeURIComponent(business.id) +
          "&network=eq." + encodeURIComponent(business.wallet_blockchain) +
          "&request_id=eq." + encodeURIComponent(input.requestId) + "&limit=1",
        { token }
      );
      withdrawal = raced?.[0] || null;
      if (!withdrawal) {
        const message = String(error?.message || "");
        if (/invoice payment is processing/i.test(message)) {
          throw new Error("A business-wallet withdrawal cannot start while an invoice payment is processing");
        }
        if (/duplicate key|wallet_withdrawals_one_processing/i.test(message)) {
          throw new Error("Another withdrawal is already processing for this business wallet");
        }
        throw error;
      }
    }
    if (!withdrawal) throw new Error("Withdrawal request could not be persisted");
  }
  if (
    withdrawal.recipient_address.toLowerCase() !== recipientAddress.toLowerCase() ||
    parseUnits(String(withdrawal.amount_usdc), 6) !== amount.units
  ) {
    throw new Error("Withdrawal request ID is already bound to different transfer details");
  }

  let policy;
  let balance;
  let reserved;
  let floor;
  let estimate;
  try {
    [policy, balance, reserved] = await Promise.all([
      policyFor(token, business),
      walletBalance(business),
      reservedInvoiceFunds(token, business)
    ]);
    floor = await cashFloor(token, business, policy);
    estimate = await estimateBusinessWalletTransfer({
      walletId: business.wallet_id,
      recipientAddress,
      amount: amount.text,
      blockchain: business.wallet_blockchain
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateWithdrawal(token, withdrawal, { status: "processing", error: "Withdrawal preflight is temporarily unavailable: " + message }).catch(() => {});
    throw error;
  }
  const feeReserve = feeUnits(estimate.fee?.networkFee);
  const withdrawable = withdrawalAvailability({ balance, cashFloor: floor, reserved, feeReserve });
  withdrawal = await updateWithdrawal(token, withdrawal, {
    cash_floor_usdc: formatUnits(floor, 6),
    reserved_usdc: formatUnits(reserved, 6),
    error: null
  });
  if (amount.units > withdrawable) {
    const message = "Withdrawal exceeds available funds after the cash floor, active-payment reservations, and estimated network fee. Available: " +
      formatUnits(withdrawable, 6) + " USDC";
    withdrawal = await updateWithdrawal(token, withdrawal, { status: "failed", error: message });
    await audit(token, withdrawal, "wallet_withdrawal_failed", { reason: message, phase: "preflight" }).catch(() => {});
    throw new Error(message);
  }
  if (createdWithdrawal) {
    await audit(token, withdrawal, "wallet_withdrawal_requested", {
      amount_usdc: Number(amount.text),
      recipient_address: recipientAddress,
      wallet_address: business.wallet_address,
      cash_floor_usdc: Number(formatUnits(floor, 6)),
      reserved_usdc: Number(formatUnits(reserved, 6)),
      estimated_network_fee_usdc: Number(estimate.fee?.networkFee || 0)
    });
  }

  try {
    const submitted = await submitBusinessWalletTransfer({
      businessId: business.id,
      walletId: business.wallet_id,
      recipientAddress,
      amount: amount.text,
      blockchain: business.wallet_blockchain,
      requestId: input.requestId,
      tokenId: estimate.tokenId
    });
    withdrawal = await updateWithdrawal(token, withdrawal, { circle_transaction_id: submitted.transactionId });
    await audit(token, withdrawal, "wallet_withdrawal_submitted", {
      circle_transaction_id: submitted.transactionId,
      amount_usdc: Number(amount.text),
      recipient_address: recipientAddress
    });
    return { withdrawal, idempotent: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    withdrawal = await updateWithdrawal(token, withdrawal, { status: "processing", error: "Circle submission outcome is uncertain: " + message });
    await audit(token, withdrawal, "wallet_withdrawal_submission_uncertain", { reason: message }).catch(() => {});
    return { withdrawal, idempotent: Boolean(existingRows?.[0]), submissionUncertain: true };
  }
}

export async function reconcilePendingWithdrawals(token = getSupabaseServerSecret(), limit = 20) {
  const rows = await supabaseRest(
    "wallet_withdrawals?select=*&status=eq.processing&order=updated_at.asc&limit=" + Math.max(1, Math.min(limit, 50)),
    { token }
  ) || [];
  const reconciled = [];
  for (const withdrawal of rows) reconciled.push(await reconcileWithdrawal(token, withdrawal));
  return reconciled;
}
