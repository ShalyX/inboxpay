import { keccak256, parseAbi, parseUnits } from "viem";
import { getBusiness } from "./businesses.mjs";
import { supabaseRest } from "./supabase-server.mjs";
import { policyClient, readPolicyState } from "./policy-sync.mjs";
import { buildPaymentPreflight } from "./payment-preflight.mjs";

const USDC = "0x3600000000000000000000000000000000000000";
const readAbi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function vendorRecipient(bytes32) view returns (address)",
  "function currentDaySpent() view returns (uint256)",
  "function canExecute(bytes32 paymentId,bytes32 vendorId,uint256 amount) view returns (bool,string)"
]);

async function one(path, token) {
  const rows = await supabaseRest(path, { token });
  return rows?.[0] || null;
}

function vendorId(name) {
  return keccak256(new TextEncoder().encode("vendor:" + name));
}

function paymentId(invoice) {
  return invoice.payment_id || keccak256(new TextEncoder().encode(
    "gmail:" + (invoice.invoice_number || "") + ":" + (invoice.external_message_id || "")
  ));
}

export async function previewBusinessInvoice(token, userId, invoiceNumber) {
  const business = await getBusiness(token, userId);
  if (!business) throw new Error("Complete business onboarding first");

  const encodedBusiness = encodeURIComponent(business.id);
  const encodedInvoice = encodeURIComponent(invoiceNumber || "");
  const [policy, invoice] = await Promise.all([
    one("policies?select=*&business_id=eq." + encodedBusiness + "&limit=1", token),
    one("invoices?select=*&business_id=eq." + encodedBusiness + "&user_id=eq." + encodeURIComponent(userId) + "&invoice_number=eq." + encodedInvoice + "&limit=1", token)
  ]);
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);

  const vendor = await one(
    "vendors?select=*&business_id=eq." + encodedBusiness + "&name=eq." + encodeURIComponent(invoice.vendor || "") + "&limit=1",
    token
  );

  let onchainPolicy = null;
  let policyAllowance = false;
  const onchain = { vendorRegistered: false, vendorStatus: "Unavailable" };
  if (business.policy_contract_status === "ready" && business.policy_contract_address && business.wallet_address) {
    const chain = policyClient(business.wallet_blockchain);
    try {
      const values = await readPolicyState(business.policy_contract_address, business.wallet_blockchain);
      onchainPolicy = {
        max_transaction_usdc: Number(values.maxTransaction) / 1e6,
        daily_limit_usdc: Number(values.dailyLimit) / 1e6,
        cash_floor_usdc: Number(values.cashFloor) / 1e6,
        paused: values.paused
      };
    } catch (error) {
      onchain.policyError = error instanceof Error ? error.message : String(error);
    }

    try {
      const id = vendorId(invoice.vendor || "");
      const amountRaw = parseUnits(String(invoice.amount || 0), 6);
      const [allowance, walletBalance, currentDaySpent, recipient, canExecute] = await Promise.all([
        chain.readContract({ address: USDC, abi: readAbi, functionName: "allowance", args: [business.wallet_address, business.policy_contract_address] }),
        chain.readContract({ address: USDC, abi: readAbi, functionName: "balanceOf", args: [business.wallet_address] }),
        chain.readContract({ address: business.policy_contract_address, abi: readAbi, functionName: "currentDaySpent" }),
        chain.readContract({ address: business.policy_contract_address, abi: readAbi, functionName: "vendorRecipient", args: [id] }),
        chain.readContract({ address: business.policy_contract_address, abi: readAbi, functionName: "canExecute", args: [paymentId(invoice), id, amountRaw] })
      ]);
      policyAllowance = allowance > 0n;
      onchain.walletBalance = Number(walletBalance) / 1e6;
      onchain.currentDaySpent = Number(currentDaySpent) / 1e6;
      onchain.vendorRecipient = recipient;
      onchain.vendorRegistered = Boolean(vendor?.recipient_address && recipient.toLowerCase() === vendor.recipient_address.toLowerCase());
      onchain.vendorStatus = onchain.vendorRegistered ? "Registered" : recipient === "0x0000000000000000000000000000000000000000" ? "Not registered" : "Mismatch";
      onchain.canExecute = { checked: true, allowed: Boolean(canExecute?.[0]), reason: canExecute?.[1] || null };
    } catch (error) {
      onchain.readError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    business,
    invoice,
    preflight: buildPaymentPreflight({
      invoice,
      business,
      policy,
      vendor,
      onchainPolicy,
      policyAllowance,
      onchain
    }),
    onchainPolicy,
    policyAllowance,
    onchain: {
      vendorStatus: onchain.vendorStatus,
      vendorRecipient: onchain.vendorRecipient || null,
      vendorRegistered: onchain.vendorRegistered,
      walletBalance: onchain.walletBalance ?? null,
      currentDaySpent: onchain.currentDaySpent ?? null,
      canExecute: onchain.canExecute || { checked: false, allowed: false, reason: null },
      readError: onchain.readError || onchain.policyError || null
    }
  };
}

