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

export function invoiceQueueCategory(invoice = {}, paymentReady = false) {
  const settlement = invoice.settlement || {};
  if (
    settlement.status === "confirmed" ||
    settlement.reconciled === true ||
    settlement.onchainDuplicate === true
  ) return "settled";
  if (paymentReady) return "ready";
  return "review";
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

export function activateDestination(destination, sections, navItems, inboxContent) {
  if (!(destination in sections)) throw new Error("Unknown workspace destination: " + destination);
  const activeSection = sections[destination];
  for (const section of new Set(Object.values(sections))) {
    if (!section) continue;
    section.hidden = section !== activeSection;
    section.classList.toggle("page-mode", section === activeSection);
  }
  for (const item of navItems) {
    const active = item.dataset.nav === destination;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  if (inboxContent) inboxContent.inert = destination !== "inbox";
}

const WORKSPACE_DESTINATIONS = new Set(["inbox", "payments", "policy", "audit", "business", "vendors"]);

export function destinationFromHash(hash = "") {
  const destination = String(hash).replace(/^#\/?/, "").trim().toLowerCase();
  return WORKSPACE_DESTINATIONS.has(destination) ? destination : "inbox";
}

const AUDIT_EVENT_LABELS = {
  business_network_selected: "Settlement environment selected",
  business_profile_updated: "Business profile updated",
  invoice_scheduled: "Invoice queued for review",
  invoice_schedule_rescheduled: "Invoice review rescheduled",
  invoice_schedule_cancelled: "Scheduled review cancelled",
  payment_submitted: "Payment submitted to Circle",
  payment_settled: "Payment settled and reconciled",
  policy_allowance_approved: "USDC access authorized",
  policy_allowance_revoked: "USDC access revoked",
  policy_pause_updated: "Emergency payment control changed",
  policy_updated: "Payment policy updated",
  vendor_policy_updated: "Vendor policy updated",
  vendor_registered: "Vendor registered",
  vendor_revoked: "Vendor revoked",
  wallet_provisioned: "Dedicated business wallet created"
};

export function auditEventLabel(type = "") {
  if (AUDIT_EVENT_LABELS[type]) return AUDIT_EVENT_LABELS[type];
  const words = String(type).replaceAll("_", " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Business event";
}

export function auditEventCategory(type = "") {
  const value = String(type);
  if (/^payment_|settlement/.test(value)) return "payments";
  if (/vendor/.test(value)) return "vendors";
  if (/policy|allowance/.test(value)) return "policy";
  if (/invoice_schedule|scheduled/.test(value)) return "schedule";
  return "business";
}

export function inboxFailurePresentation(message = "") {
  const authRevoked = /token has been expired or revoked|invalid_grant|gmail authorization must be renewed/i.test(message);
  if (authRevoked) {
    return {
      kind: "reauthorization",
      title: "Reconnect your business inbox",
      message: "Google no longer accepts the saved Gmail authorization. Reconnect the account to continue evaluating invoices. Your wallet and payment policy are unchanged.",
      actionLabel: "Reconnect Gmail",
      feedLabel: "Reconnect required",
      feedMeta: "Google access expired · reconnect to resume invoice evaluation"
    };
  }

  return {
    kind: "service",
    title: "Live inbox temporarily unavailable",
    message: "InboxPay could not securely read this Gmail connection. Retry in a moment. If the problem continues, the inbox integration needs operator attention.",
    actionLabel: "Retry inbox evaluation",
    feedLabel: "Live inbox unavailable",
    feedMeta: "Invoice evaluation failed · retry in a moment"
  };
}
