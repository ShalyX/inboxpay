export function networkLabel(network) {
  if (network === "ARC") return "Arc Mainnet";
  if (network === "ARC-TESTNET") return "Arc Testnet";
  return "Arc";
}

export function paymentFlowStep({ selected, preflight, preflightLoading = false } = {}) {
  if (!selected) return 0;

  const settlementStatus = selected.settlement?.status;
  if (
    settlementStatus === "confirmed" ||
    settlementStatus === "processing" ||
    selected.settlement?.reconciled === true ||
    selected.settlement?.onchainDuplicate === true
  ) return 4;

  if (preflight?.eligible) return 3;
  if (preflightLoading || preflight) return 2;
  return 1;
}

export function singleFlight(action) {
  let pending = null;
  return (...args) => {
    if (pending) return pending;
    pending = Promise.resolve(action(...args))
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export function inboxFailurePresentation(message = "") {
  const authRevoked = /token has been expired or revoked|invalid_grant|gmail authorization must be renewed/i.test(message);
  if (authRevoked) {
    return {
      kind: "reauthorization",
      title: "Reconnect your business inbox",
      message: "Google no longer accepts the saved Gmail authorization. Reconnect the account to continue evaluating invoices. Your wallet and payment policy are unchanged.",
      actionLabel: "Reconnect Gmail",
      feedLabel: "Gmail authorization needed",
      feedMeta: "Source: Gmail authorization expired · Reconnect to resume evaluation"
    };
  }

  return {
    kind: "service",
    title: "Live inbox temporarily unavailable",
    message: "InboxPay could not securely read this Gmail connection. Retry in a moment. If the problem continues, the inbox integration needs operator attention.",
    actionLabel: "Retry inbox evaluation",
    feedLabel: "Live Gmail operator",
    feedMeta: "Source: live Gmail unavailable · Evaluation failed"
  };
}
