const SETTLEMENT_STATES = new Set(["processing", "review"]);

function amountOf(invoice) {
  const value = Number(invoice?.amount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function limitOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addCheck(checks, key, label, ok, value, reason) {
  checks.push({
    key,
    label,
    ok: Boolean(ok),
    value: value || (ok ? "Ready" : "Blocked"),
    reason: reason || null
  });
}

export function buildPaymentPreflight({
  invoice,
  business,
  policy,
  vendor,
  onchainPolicy,
  policyAllowance,
  onchain = {}
} = {}) {
  const checks = [];
  const reasons = [];
  const amount = amountOf(invoice);
  const settlementStatus = invoice?.settlement_status || invoice?.settlement?.status || null;
  const settled = settlementStatus === "confirmed" || invoice?.settlement?.reconciled === true;
  const invoiceNumber = invoice?.invoice_number || invoice?.invoiceNumber;
  const dueDate = invoice?.due_date || invoice?.dueDate;
  const requiredFields = Boolean(invoiceNumber && amount > 0 && dueDate);
  addCheck(
    checks,
    "required_fields",
    "Required invoice fields",
    requiredFields,
    requiredFields ? "Complete" : "Review",
    requiredFields ? null : "Invoice number, amount, and due date are required."
  );

  const decisionReady = invoice?.decision === "PAY_NOW" || invoice?.agentDecision === "PAY_NOW";
  addCheck(
    checks,
    "agent_decision",
    "Agent decision",
    decisionReady,
    invoice?.decision || invoice?.agentDecision || "Unknown",
    decisionReady ? null : "The bounded agent decision is not PAY_NOW."
  );

  const currencyReady = String(invoice?.currency || "").toUpperCase() === "USDC";
  addCheck(
    checks,
    "currency",
    "Currency rail",
    currencyReady,
    invoice?.currency || "Unknown",
    currencyReady ? null : "Only USDC invoices can settle on the configured Arc rail."
  );

  const vendorReady = vendor?.status === "verified";
  addCheck(
    checks,
    "vendor_registry",
    "Vendor registry",
    vendorReady,
    vendor ? vendor.status : "Not registered",
    vendorReady ? null : "The vendor must be explicitly verified for this business."
  );

  const vendorOnchain = onchain.vendorRegistered === true;
  addCheck(
    checks,
    "vendor_onchain",
    "Onchain vendor registration",
    vendorOnchain,
    onchain.vendorStatus || (onchain.vendorRecipient ? "Mismatch" : "Not registered"),
    vendorOnchain ? null : "The verified vendor recipient is not registered in this business's active policy vault."
  );

  const walletReady = Boolean(business?.wallet_id && business?.wallet_address && business?.wallet_status === "ready");
  addCheck(
    checks,
    "business_wallet",
    "Dedicated business wallet",
    walletReady,
    walletReady ? "Ready" : business?.wallet_status || "Not ready",
    walletReady ? null : "This business's dedicated Circle wallet is not ready."
  );

  const vaultReady = Boolean(business?.policy_contract_address && business?.policy_contract_status === "ready");
  addCheck(
    checks,
    "policy_vault",
    "Policy vault",
    vaultReady,
    vaultReady ? "Ready" : business?.policy_contract_status || "Not deployed",
    vaultReady ? null : "The business policy vault is not ready onchain."
  );

  const allowanceReady = policyAllowance === true;
  addCheck(
    checks,
    "usdc_allowance",
    "USDC authorization",
    allowanceReady,
    allowanceReady ? "Authorized" : "Required",
    allowanceReady ? null : "The business must explicitly authorize its policy vault to access USDC."
  );

  const paused = Boolean(onchainPolicy?.paused ?? policy?.paused);
  addCheck(
    checks,
    "pause",
    "Emergency pause",
    !paused,
    paused ? "Paused" : "Ready",
    paused ? "Payments are paused for this business." : null
  );

  const maxTransaction = limitOf(onchainPolicy?.max_transaction_usdc ?? policy?.max_transaction_usdc);
  const maxReady = maxTransaction !== null && amount <= maxTransaction;
  addCheck(
    checks,
    "max_transaction",
    "Per-payment limit",
    maxReady,
    maxTransaction === null ? "Unavailable" : amount.toFixed(6) + " / " + maxTransaction.toFixed(6) + " USDC",
    maxReady ? null : maxTransaction === null
      ? "The live policy limit could not be read."
      : "This invoice exceeds the business's maximum single-payment limit."
  );

  const dailyLimit = limitOf(onchainPolicy?.daily_limit_usdc ?? policy?.daily_limit_usdc);
  const dailySpent = limitOf(onchain.currentDaySpent);
  const dailyReady = dailyLimit !== null && dailySpent !== null && dailySpent + amount <= dailyLimit;
  addCheck(
    checks,
    "daily_limit",
    "Daily spending headroom",
    dailyReady,
    dailyLimit === null || dailySpent === null
      ? "Unavailable"
      : Math.max(0, dailyLimit - dailySpent).toFixed(6) + " USDC remaining",
    dailyReady ? null : dailyLimit === null || dailySpent === null
      ? "The live daily spending state could not be read."
      : "This invoice would exceed the business's daily spending limit."
  );

  const cashFloor = limitOf(onchainPolicy?.cash_floor_usdc ?? policy?.cash_floor_usdc);
  const walletBalance = limitOf(onchain.walletBalance);
  const cashFloorReady = cashFloor !== null && walletBalance !== null && walletBalance >= amount + cashFloor;
  addCheck(
    checks,
    "cash_floor",
    "Cash-floor headroom",
    cashFloorReady,
    cashFloor === null || walletBalance === null
      ? "Unavailable"
      : walletBalance.toFixed(6) + " USDC balance / " + cashFloor.toFixed(6) + " USDC floor",
    cashFloorReady ? null : cashFloor === null || walletBalance === null
      ? "The live wallet balance or cash floor could not be read."
      : "This invoice would breach the business's cash-floor rule."
  );

  const canExecuteReady = onchain.canExecute?.checked === true && onchain.canExecute.allowed === true;
  const canExecuteValue = onchain.canExecute?.checked !== true
    ? "Unavailable"
    : onchain.canExecute.reason || (canExecuteReady ? "ALLOWED" : "Blocked");
  addCheck(
    checks,
    "onchain_can_execute",
    "Onchain execution preflight",
    canExecuteReady,
    canExecuteValue,
    canExecuteReady ? null : onchain.canExecute?.reason
      ? "The policy vault rejected this payment: " + onchain.canExecute.reason
      : "The policy vault execution check could not be read."
  );

  const settlementReady = !settled && !SETTLEMENT_STATES.has(settlementStatus);
  addCheck(
    checks,
    "settlement_state",
    "Settlement state",
    settlementReady,
    settled ? "Already settled" : settlementStatus || "Not submitted",
    settlementReady ? null : settled
      ? "This invoice has already been reconciled and cannot be paid again."
      : "This payment is already in progress or requires reconciliation review."
  );

  for (const check of checks) {
    if (!check.ok && check.reason) reasons.push(check.reason);
  }

  return {
    eligible: checks.every((check) => check.ok),
    invoiceNumber: invoiceNumber || null,
    amount,
    currency: invoice?.currency || null,
    vendor: invoice?.vendor || null,
    checks,
    reasons
  };
}

