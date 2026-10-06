import { keccak256, parseAbi, parseUnits, formatUnits } from "viem";
import { getBusiness } from "./business-data.mjs";
import { policyClient, writePolicy } from "./policy-sync.mjs";
import { supabaseRest } from "./supabase-server.mjs";

const USDC = "0x3600000000000000000000000000000000000000";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)"
]);

const vaultAbi = parseAbi([
  "function canExecute(bytes32 paymentId,bytes32 vendorId,uint256 amount) view returns (bool,string)",
  "function usedPayment(bytes32 paymentId) view returns (bool)",
  "function vaultBalance() view returns (uint256)"
]);

function id(value) {
  return keccak256(new TextEncoder().encode(value));
}

async function getPolicy(token, userId) {
  const rows = await supabaseRest(
    "policies?select=*&user_id=eq." + encodeURIComponent(userId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

async function getInvoice(token, userId, invoiceNumber) {
  const rows = await supabaseRest(
    "invoices?select=*&user_id=eq." + encodeURIComponent(userId) +
      "&invoice_number=eq." + encodeURIComponent(invoiceNumber) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

async function getVendor(token, businessId, name) {
  const rows = await supabaseRest(
    "vendors?select=*&business_id=eq." + encodeURIComponent(businessId) +
      "&name=eq." + encodeURIComponent(name) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

async function audit(token, values) {
  await supabaseRest("audit_events", {
    token,
    method: "POST",
    body: values
  });
}

export async function settleBusinessInvoice(token, userId, invoiceNumber) {
  const [business, policy, invoice] = await Promise.all([
    getBusiness(token, userId),
    getPolicy(token, userId),
    getInvoice(token, userId, invoiceNumber)
  ]);

  if (!business?.wallet_id || !business.wallet_address) {
    throw new Error("Business wallet is not ready");
  }
  if (!business.policy_contract_address || business.policy_contract_status !== "ready") {
    throw new Error("Blocked: onchain policy vault is not ready");
  }
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);
  if (!policy) throw new Error("Business payment policy is not configured");
  if (policy.paused) throw new Error("Payment blocked: business policy is paused");
  if (invoice.settlement_status === "confirmed") throw new Error("Blocked: invoice is already settled");
  if (invoice.settlement_status === "processing") throw new Error("Payment already in progress");
  if (invoice.decision !== "PAY_NOW") throw new Error("Blocked by agent decision: " + invoice.decision);
  if (invoice.currency !== "USDC") throw new Error("Blocked: settlement currency is " + invoice.currency);

  const vendor = await getVendor(token, business.id, invoice.vendor);
  if (!vendor || vendor.status !== "verified") throw new Error("Blocked: vendor is not verified");
  if (vendor.currency !== "USDC") throw new Error("Blocked: vendor settlement rail is not USDC");

  const amount = Number(invoice.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invoice amount is invalid");
  if (amount > Number(policy.max_transaction_usdc)) {
    throw new Error("Blocked by business policy: transaction exceeds the per-payment limit");
  }

  const amountRaw = parseUnits(String(amount), 6);
  const paymentId = invoice.payment_id || id("gmail:" + (invoice.invoice_number || "") + ":" + (invoice.external_message_id || ""));
  const vendorId = id("vendor:" + invoice.vendor);
  const invoiceHash = id([
    invoice.vendor,
    invoice.invoice_number,
    String(invoice.amount),
    invoice.currency,
    invoice.due_date || ""
  ].join("|"));

  const chain = policyClient(business.wallet_blockchain);
  const [beforeVendor, vaultBalance, allowanceCheck] = await Promise.all([
    chain.readContract({
      address: USDC,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [vendor.recipient_address]
    }),
    chain.readContract({
      address: business.policy_contract_address,
      abi: vaultAbi,
      functionName: "vaultBalance"
    }),
    chain.readContract({
      address: business.policy_contract_address,
      abi: vaultAbi,
      functionName: "canExecute",
      args: [paymentId, vendorId, amountRaw]
    })
  ]);

  if (!allowanceCheck[0]) {
    throw new Error("Blocked by onchain policy vault: " + allowanceCheck[1]);
  }

  if (business.wallet_blockchain === "ARC") {
    if (String(token) && String(process.env.INBOXPAY_ALLOW_MAINNET_WRITES) !== "true") {
      throw new Error("Mainnet payment execution is disabled until InboxPay explicitly enables mainnet writes");
    }
  }

  const claim = await supabaseRest(
    "invoices?id=eq." + encodeURIComponent(invoice.id) +
      "&settlement_status=is.null",
    {
      token,
      method: "PATCH",
      body: {
        settlement_status: "processing",
        payment_id: paymentId,
        updated_at: new Date().toISOString()
      }
    }
  );
  if (!claim?.[0]) throw new Error("Payment already claimed by another execution");

  try {
    const tx = await writePolicy({
      walletId: business.wallet_id,
      contractAddress: business.policy_contract_address,
      abiFunctionSignature: "executePayment(bytes32,bytes32,uint256,bytes32)",
      abiParameters: [paymentId, vendorId, String(amountRaw), invoiceHash],
      blockchain: business.wallet_blockchain
    });

    const [afterVendor, usedPayment] = await Promise.all([
      chain.readContract({
        address: USDC,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [vendor.recipient_address]
      }),
      chain.readContract({
        address: business.policy_contract_address,
        abi: vaultAbi,
        functionName: "usedPayment",
        args: [paymentId]
      })
    ]);

    if (!usedPayment || afterVendor < beforeVendor + amountRaw) {
      throw new Error("Arc transaction completed but payment reconciliation failed");
    }

    const updated = await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(invoice.id),
      {
        token,
        method: "PATCH",
        body: {
          settlement_status: "confirmed",
          payment_tx_hash: tx.txHash,
          payment_id: paymentId,
          updated_at: new Date().toISOString()
        }
      }
    );

    await audit(token, {
      user_id: userId,
      business_id: business.id,
      invoice_id: invoice.id,
      event_type: "payment_settled",
      actor: "agent",
      data: {
        invoice_number: invoice.invoice_number,
        vendor: invoice.vendor,
        amount_usdc: amount,
        tx_hash: tx.txHash,
        wallet_address: business.wallet_address,
        policy_vault: business.policy_contract_address,
        vault_balance_before_usdc: Number(formatUnits(vaultBalance, 6))
      }
    });

    return {
      invoiceNumber: invoice.invoice_number,
      vendor: invoice.vendor,
      amount: formatUnits(amountRaw, 6) + " USDC",
      paymentTxHash: tx.txHash,
      walletAddress: business.wallet_address,
      policyVaultAddress: business.policy_contract_address,
      reconciled: true,
      invoice: updated?.[0] || null
    };
  } catch (error) {
    await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(invoice.id),
      {
        token,
        method: "PATCH",
        body: {
          settlement_status: "failed",
          updated_at: new Date().toISOString()
        }
      }
    ).catch(() => {});
    throw error;
  }
}
