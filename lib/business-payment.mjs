import crypto from "node:crypto";
import { decodeEventLog, keccak256, parseAbi, parseUnits, formatUnits } from "viem";
import { getBusiness } from "./businesses.mjs";
import { CircleTransactionError, circleStateDisposition, policyClient, readCircleTransaction, writePolicy } from "./policy-sync.mjs";
import { supabaseRest } from "./supabase-server.mjs";

const USDC = "0x3600000000000000000000000000000000000000";
const MAX_PAYMENT_SUBMISSION_ATTEMPTS = 5;

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)"
]);

const vaultAbi = parseAbi([
  "function canExecute(bytes32 paymentId,bytes32 vendorId,uint256 amount) view returns (bool,string)",
  "function usedPayment(bytes32 paymentId) view returns (bool)",
  "function vaultBalance() view returns (uint256)",
  "event PaymentExecuted(bytes32 indexed paymentId, bytes32 indexed vendorId, address indexed recipient, uint256 amount, bytes32 invoiceHash)"
]);

function id(value) {
  return keccak256(new TextEncoder().encode(value));
}

export function paymentIdempotencyKey(businessId, paymentId, attempt) {
  const bytes = crypto.createHash("sha256")
    .update(["inboxpay-payment", businessId, paymentId, String(attempt)].join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function invoiceHashFor(invoice) {
  return id([
    invoice.vendor,
    invoice.invoice_number,
    String(invoice.amount),
    invoice.currency,
    invoice.due_date || ""
  ].join("|"));
}

function paymentExpectation(invoice, vendor, paymentId) {
  return {
    paymentId,
    vendorId: id("vendor:" + invoice.vendor),
    recipient: vendor?.recipient_address?.toLowerCase() || null,
    amount: parseUnits(String(invoice.amount), 6),
    invoiceHash: invoiceHashFor(invoice)
  };
}

export function matchesPaymentExecutedEvent(args, expected) {
  return args?.paymentId?.toLowerCase() === expected.paymentId.toLowerCase() &&
    (!expected.vendorId || args.vendorId?.toLowerCase() === expected.vendorId.toLowerCase()) &&
    (!expected.recipient || args.recipient?.toLowerCase() === expected.recipient.toLowerCase()) &&
    (expected.amount === undefined || args.amount === expected.amount) &&
    (!expected.invoiceHash || args.invoiceHash?.toLowerCase() === expected.invoiceHash.toLowerCase());
}

export function paymentRetryAllowed(previousAttempts) {
  return Number.isInteger(previousAttempts) &&
    previousAttempts >= 0 &&
    previousAttempts < MAX_PAYMENT_SUBMISSION_ATTEMPTS;
}

export function classifyArcReceipt({ receipt, transactionTo, expectedPolicyVault, usedPayment, paymentEventMatches }) {
  if (!receipt) return "processing";
  if (receipt.status !== "success") return "failed";
  if (
    transactionTo?.toLowerCase() !== expectedPolicyVault?.toLowerCase() ||
    !usedPayment ||
    !paymentEventMatches
  ) return "review";
  return "confirmed";
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
  return supabaseRest("audit_events", {
    token,
    method: "POST",
    body: values
  });
}

async function paymentSubmissionEvents(token, invoiceId) {
  return await supabaseRest(
    "audit_events?select=id,data,created_at&invoice_id=eq." + encodeURIComponent(invoiceId) +
      "&event_type=eq.payment_submitted&order=created_at.desc&limit=20",
    { token }
  ) || [];
}

async function updateInvoice(token, invoiceId, values, filter = "") {
  const rows = await supabaseRest(
    "invoices?id=eq." + encodeURIComponent(invoiceId) + filter,
    { token, method: "PATCH", body: { ...values, updated_at: new Date().toISOString() } }
  );
  return rows?.[0] || null;
}

function resultFor(invoice, business, values = {}) {
  return {
    invoiceNumber: invoice.invoice_number,
    vendor: invoice.vendor,
    amount: formatUnits(parseUnits(String(invoice.amount), 6), 6) + " USDC",
    paymentTxHash: invoice.payment_tx_hash || null,
    walletAddress: business.wallet_address,
    policyVaultAddress: business.policy_contract_address,
    status: invoice.settlement_status || "pending",
    reconciled: invoice.settlement_status === "confirmed",
    invoice,
    ...values
  };
}

async function markPaymentFailed(token, userId, business, invoice, details) {
  const updated = await updateInvoice(token, invoice.id, { settlement_status: "failed" });
  await audit(token, {
    user_id: userId,
    business_id: business.id,
    invoice_id: invoice.id,
    event_type: "payment_failed",
    actor: "agent",
    data: details
  }).catch((error) => console.error("InboxPay payment failure audit failed", { invoiceId: invoice.id, message: error.message }));
  return updated || { ...invoice, settlement_status: "failed" };
}

async function markPaymentReview(token, userId, business, invoice, details) {
  const updated = await updateInvoice(token, invoice.id, { settlement_status: "review" });
  await audit(token, {
    user_id: userId,
    business_id: business.id,
    invoice_id: invoice.id,
    event_type: "payment_reconciliation_review",
    actor: "agent",
    data: details
  }).catch((error) => console.error("InboxPay payment review audit failed", { invoiceId: invoice.id, message: error.message }));
  return updated || { ...invoice, settlement_status: "review" };
}

async function markPaymentConfirmed(token, userId, business, invoice, txHash, details = {}) {
  const updated = await updateInvoice(token, invoice.id, {
    settlement_status: "confirmed",
    payment_tx_hash: txHash,
    payment_id: invoice.payment_id
  }, "&settlement_status=neq.confirmed");
  if (updated) {
    await audit(token, {
      user_id: userId,
      business_id: business.id,
      invoice_id: invoice.id,
      event_type: "payment_settled",
      actor: "agent",
      data: {
        invoice_number: invoice.invoice_number,
        vendor: invoice.vendor,
        amount_usdc: Number(invoice.amount),
        tx_hash: txHash,
        wallet_address: business.wallet_address,
        policy_vault: business.policy_contract_address,
        ...details
      }
    });
  }
  return resultFor(updated || { ...invoice, settlement_status: "confirmed", payment_tx_hash: txHash }, business, {
    paymentTxHash: txHash,
    status: "confirmed",
    reconciled: true
  });
}

async function reconcileArcTransaction(token, userId, business, invoice, txHash, expected) {
  const chain = policyClient(business.wallet_blockchain);
  let receipt;
  let transaction;
  let usedPayment;
  try {
    [receipt, transaction, usedPayment] = await Promise.all([
      chain.getTransactionReceipt({ hash: txHash }),
      chain.getTransaction({ hash: txHash }),
      chain.readContract({
        address: business.policy_contract_address,
        abi: vaultAbi,
        functionName: "usedPayment",
        args: [expected.paymentId]
      })
    ]);
  } catch (error) {
    return resultFor({ ...invoice, payment_tx_hash: txHash }, business, {
      paymentTxHash: txHash,
      status: "processing",
      reconciled: false,
      recoveryMessage: "Arc receipt is not available yet"
    });
  }

  const paymentLog = receipt.status === "success" && receipt.logs.find((log) => {
    try {
      const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
      return decoded.eventName === "PaymentExecuted" &&
        matchesPaymentExecutedEvent(decoded.args || {}, expected);
    } catch {
      return false;
    }
  });
  const receiptDecision = classifyArcReceipt({
    receipt,
    transactionTo: transaction.to,
    expectedPolicyVault: business.policy_contract_address,
    usedPayment,
    paymentEventMatches: Boolean(paymentLog)
  });

  if (receiptDecision === "failed") {
    const failed = await markPaymentFailed(token, userId, business, invoice, {
      tx_hash: txHash,
      reason: "Arc transaction reverted"
    });
    return resultFor(failed, business, { paymentTxHash: txHash, status: "failed", reconciled: false });
  }

  if (receiptDecision === "review") {
    const review = await markPaymentReview(token, userId, business, invoice, {
      tx_hash: txHash,
      transaction_to: transaction.to || null,
      expected_policy_vault: business.policy_contract_address,
      used_payment: Boolean(usedPayment),
      reason: "Arc receipt did not match the expected policy-vault payment"
    });
    return resultFor(review, business, { paymentTxHash: txHash, status: "review", reconciled: false });
  }

  return markPaymentConfirmed(token, userId, business, invoice, txHash, {
    circle_transaction_id: expected.circleTransactionId || null
  });
}

async function recoverPendingPayment(token, userId, business, invoice, expected) {
  const events = await paymentSubmissionEvents(token, invoice.id);
  const rawSubmission = events[0]?.data;
  const submission = typeof rawSubmission === "string"
    ? (() => {
        try { return JSON.parse(rawSubmission); } catch { return {}; }
      })()
    : rawSubmission || {};
  const circleTransactionId = submission.circle_transaction_id || null;
  const txHash = invoice.payment_tx_hash || submission.tx_hash || null;

  if (txHash) {
    return reconcileArcTransaction(token, userId, business, invoice, txHash, {
      ...expected,
      circleTransactionId
    });
  }
  if (!circleTransactionId) return null;

  let provider;
  try {
    provider = await readCircleTransaction(circleTransactionId, business.wallet_blockchain);
  } catch {
    return resultFor(invoice, business, {
      circleTransactionId,
      status: "processing",
      reconciled: false,
      recoveryMessage: "Circle status is temporarily unavailable"
    });
  }

  const providerState = String(provider?.state || "UNKNOWN").toUpperCase();
  if (circleStateDisposition(providerState).terminal) {
    const failed = await markPaymentFailed(token, userId, business, invoice, {
      circle_transaction_id: circleTransactionId,
      provider_state: providerState,
      reason: provider?.errorDetails || provider?.errorReason || "Circle transaction failed"
    });
    return resultFor(failed, business, { circleTransactionId, status: "failed", reconciled: false });
  }
  if (providerState !== "COMPLETE") {
    return resultFor(invoice, business, {
      circleTransactionId,
      status: "processing",
      reconciled: false,
      recoveryMessage: "Circle is still processing this payment"
    });
  }

  const completedHash = provider.txHash || provider.hash || null;
  if (!completedHash) {
    return resultFor(invoice, business, {
      circleTransactionId,
      status: "processing",
      reconciled: false,
      recoveryMessage: "Circle completed the request but has not exposed the Arc transaction hash"
    });
  }
  await updateInvoice(token, invoice.id, { payment_tx_hash: completedHash });
  return reconcileArcTransaction(token, userId, business, { ...invoice, payment_tx_hash: completedHash }, completedHash, {
    ...expected,
    circleTransactionId
  });
}

export async function recoverPendingBusinessInvoices(token, userId, business, invoices = []) {
  const recovered = [];
  for (const invoice of invoices) {
    if (invoice?.settlement_status !== "processing") {
      recovered.push(invoice);
      continue;
    }

    const paymentId = invoice.payment_id;
    if (!paymentId) {
      const review = await markPaymentReview(token, userId, business, invoice, {
        reason: "Processing invoice has no payment identifier for recovery"
      });
      recovered.push(review);
      continue;
    }

    try {
      const vendor = await getVendor(token, business.id, invoice.vendor);
      const result = await recoverPendingPayment(
        token,
        userId,
        business,
        invoice,
        paymentExpectation(invoice, vendor, paymentId)
      );
      recovered.push(result?.invoice || {
        ...invoice,
        settlement_status: result?.status || invoice.settlement_status,
        payment_tx_hash: result?.paymentTxHash || invoice.payment_tx_hash
      });
    } catch (error) {
      console.error("InboxPay pending payment recovery failed", {
        invoiceId: invoice.id,
        message: error?.message || String(error)
      });
      recovered.push(invoice);
    }
  }
  return recovered;
}

export async function settleBusinessInvoice(token, userId, invoiceNumber) {
  const [business, policy, loadedInvoice] = await Promise.all([
    getBusiness(token, userId),
    getPolicy(token, userId),
    getInvoice(token, userId, invoiceNumber)
  ]);
  let invoice = loadedInvoice;

  if (!business?.wallet_id || !business.wallet_address) {
    throw new Error("Business wallet is not ready");
  }
  if (!business.policy_contract_address || business.policy_contract_status !== "ready") {
    throw new Error("Blocked: onchain policy vault is not ready");
  }
  if (!invoice) throw new Error("Invoice not found: " + invoiceNumber);
  if (!policy) throw new Error("Business payment policy is not configured");
  if (invoice.settlement_status === "confirmed") throw new Error("Blocked: invoice is already settled");

  if (invoice.settlement_status === "processing") {
    const paymentId = invoice.payment_id;
    if (!paymentId) throw new Error("Payment is in progress but has no recovery identifier");
    const vendor = await getVendor(token, business.id, invoice.vendor);
    const recovered = await recoverPendingPayment(
      token,
      userId,
      business,
      invoice,
      paymentExpectation(invoice, vendor, paymentId)
    );
    if (!recovered) throw new Error("Payment is in progress; recovery metadata is not available yet");
    if (recovered.status !== "failed") return recovered;
    invoice = recovered.invoice || invoice;
  }

  if (invoice.settlement_status && invoice.settlement_status !== "failed") {
    throw new Error("Payment requires review before another submission: " + invoice.settlement_status);
  }
  if (policy.paused) throw new Error("Payment blocked: business policy is paused");
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
  const expectation = paymentExpectation(invoice, vendor, paymentId);
  const vendorId = expectation.vendorId;
  const invoiceHash = expectation.invoiceHash;

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

  const priorSubmissions = await paymentSubmissionEvents(token, invoice.id);
  if (!paymentRetryAllowed(priorSubmissions.length)) {
    throw new Error("Automatic payment retries are exhausted. Review the audit trail before any further action.");
  }
  const attempt = priorSubmissions.length + 1;
  const idempotencyKey = paymentIdempotencyKey(business.id, paymentId, attempt);
  const claim = await supabaseRest(
    "invoices?id=eq." + encodeURIComponent(invoice.id) +
      "&or=(settlement_status.is.null,settlement_status.eq.failed)",
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

  let submittedTransactionId = null;
  try {
    const tx = await writePolicy({
      walletId: business.wallet_id,
      contractAddress: business.policy_contract_address,
      abiFunctionSignature: "executePayment(bytes32,bytes32,uint256,bytes32)",
      abiParameters: [paymentId, vendorId, String(amountRaw), invoiceHash],
      blockchain: business.wallet_blockchain,
      idempotencyKey,
      onSubmitted: async ({ transactionId }) => {
        submittedTransactionId = transactionId;
        await updateInvoice(token, invoice.id, {
          settlement_status: "processing",
          payment_id: paymentId
        }).catch((error) => console.error("InboxPay could not persist payment state", { invoiceId: invoice.id, message: error.message }));
        await audit(token, {
          user_id: userId,
          business_id: business.id,
          invoice_id: invoice.id,
          event_type: "payment_submitted",
          actor: "agent",
          data: {
            invoice_number: invoice.invoice_number,
            payment_id: paymentId,
            circle_transaction_id: transactionId,
            idempotency_key: idempotencyKey,
            attempt,
            network: business.wallet_blockchain,
            wallet_address: business.wallet_address,
            policy_vault: business.policy_contract_address
          }
        }).catch((error) => console.error("InboxPay could not persist payment submission audit", {
          invoiceId: invoice.id,
          circleTransactionId: transactionId,
          message: error.message
        }));
      }
    });

    if (!tx.txHash) {
      return resultFor({ ...invoice, settlement_status: "processing" }, business, {
        circleTransactionId: submittedTransactionId,
        status: "processing",
        reconciled: false,
        recoveryMessage: "Circle completed the request but has not exposed the Arc transaction hash"
      });
    }

    await updateInvoice(token, invoice.id, { payment_tx_hash: tx.txHash, settlement_status: "processing" });

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
      await updateInvoice(token, invoice.id, { payment_tx_hash: tx.txHash, settlement_status: "processing" });
      await audit(token, {
        user_id: userId,
        business_id: business.id,
        invoice_id: invoice.id,
        event_type: "payment_reconciliation_review",
        actor: "agent",
        data: {
          tx_hash: tx.txHash,
          payment_id: paymentId,
          used_payment: Boolean(usedPayment),
          reason: "Arc transaction completed but the recipient balance or payment marker is not reconciled"
        }
      }).catch(() => {});
      return resultFor({ ...invoice, settlement_status: "processing", payment_tx_hash: tx.txHash }, business, {
        paymentTxHash: tx.txHash,
        status: "processing",
        reconciled: false,
        recoveryMessage: "Arc transaction completed; reconciliation is still required"
      });
    }

    const updated = await updateInvoice(token, invoice.id, {
      settlement_status: "confirmed",
      payment_tx_hash: tx.txHash,
      payment_id: paymentId
    });

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
        circle_transaction_id: submittedTransactionId,
        wallet_address: business.wallet_address,
        policy_vault: business.policy_contract_address,
        vault_balance_before_usdc: Number(formatUnits(vaultBalance, 6))
      }
    });

    return resultFor(updated || { ...invoice, settlement_status: "confirmed", payment_tx_hash: tx.txHash }, business, {
      paymentTxHash: tx.txHash,
      status: "confirmed",
      reconciled: true
    });
  } catch (error) {
    if (error instanceof CircleTransactionError && !error.terminal) {
      return resultFor({ ...invoice, settlement_status: "processing" }, business, {
        circleTransactionId: error.transactionId,
        status: "processing",
        reconciled: false,
        recoveryMessage: error.message
      });
    }
    if (error instanceof CircleTransactionError && error.terminal) {
      await updateInvoice(token, invoice.id, { settlement_status: "failed" }).catch(() => {});
      await audit(token, {
        user_id: userId,
        business_id: business.id,
        invoice_id: invoice.id,
        event_type: "payment_failed",
        actor: "agent",
        data: {
          circle_transaction_id: error.transactionId,
          provider_state: error.state,
          reason: error.message
        }
      }).catch(() => {});
      throw new Error("Payment submission failed before settlement: " + error.message, { cause: error });
    }
    if (!submittedTransactionId) {
      await updateInvoice(token, invoice.id, { settlement_status: "failed" }).catch(() => {});
    }
    throw error;
  }
}
