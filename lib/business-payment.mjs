import { createPublicClient, http, encodeFunctionData, parseAbi, parseUnits, formatUnits } from "viem";
import { circleSignTransaction } from "./circle-signing.mjs";
import { getBusiness } from "./business-data.mjs";
import { supabaseRest } from "./supabase-server.mjs";

const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)"
]);

function client() {
  return createPublicClient({ transport: http(ARC_RPC) });
}

async function signAndBroadcast(wallet, to, data, memo) {
  const chain = client();
  const nonce = await chain.getTransactionCount({ address: wallet.address });
  const gas = await chain.estimateGas({
    account: wallet.address,
    to,
    data
  });
  const fees = await chain.estimateFeesPerGas();
  const unsigned = {
    chainId: CHAIN_ID,
    nonce: String(nonce),
    to,
    data,
    value: "0x0",
    gas: String(gas),
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
  };
  const signed = await circleSignTransaction({
    walletId: wallet.id,
    transaction: JSON.stringify(unsigned),
    memo
  });
  const hash = await chain.sendRawTransaction({ serializedTransaction: signed.signedTransaction });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Arc transaction reverted: " + hash);
  return { hash, receipt };
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

async function dailySpent(token, userId) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await supabaseRest(
    "audit_events?select=data,event_type,created_at&user_id=eq." + encodeURIComponent(userId) +
      "&event_type=eq.payment_settled&created_at=gte." + encodeURIComponent(start.toISOString()) +
      "&limit=500",
    { token }
  );
  return (rows || []).reduce((sum, row) => sum + Number(row.data?.amount_usdc || 0), 0);
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

  const spent = await dailySpent(token, userId);
  if (spent + amount > Number(policy.daily_limit_usdc)) {
    throw new Error("Blocked by business policy: daily payment limit would be exceeded");
  }

  const chain = client();
  const beforeBalance = await chain.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [business.wallet_address]
  });
  const required = parseUnits(String(amount), 6);
  const floor = parseUnits(String(policy.cash_floor_usdc), 6);
  if (beforeBalance < required + floor) {
    throw new Error(
      "Blocked by business policy: wallet would fall below the " +
      formatUnits(floor, 6) + " USDC cash floor"
    );
  }

  const claim = await supabaseRest(
    "invoices?id=eq." + encodeURIComponent(invoice.id) + "&settlement_status=is.null",
    {
      token,
      method: "PATCH",
      body: { settlement_status: "processing", updated_at: new Date().toISOString() }
    }
  );
  if (!claim?.[0]) throw new Error("Payment already claimed by another execution");

  try {
    const payment = await signAndBroadcast(
      { id: business.wallet_id, address: business.wallet_address },
      USDC,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [vendor.recipient_address, required]
      }),
      "InboxPay: settle " + invoice.invoice_number + " for " + business.name
    );

    const afterBalance = await chain.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [business.wallet_address]
    });

    const updated = await supabaseRest(
      "invoices?id=eq." + encodeURIComponent(invoice.id),
      {
        token,
        method: "PATCH",
        body: {
          settlement_status: "confirmed",
          payment_tx_hash: payment.hash,
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
        tx_hash: payment.hash,
        wallet_address: business.wallet_address,
        balance_after_usdc: Number(formatUnits(afterBalance, 6))
      }
    });

    return {
      invoiceNumber: invoice.invoice_number,
      vendor: invoice.vendor,
      amount: formatUnits(required, 6) + " USDC",
      paymentTxHash: payment.hash,
      walletAddress: business.wallet_address,
      reconciled: afterBalance === beforeBalance - required,
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
