const state = {
  invoices: [],
  selected: null,
  loading: false
};

const $ = (id) => document.getElementById(id);

function status(decision) {
  const map = {
    PAY_NOW: ["approved", "Pay now"],
    HOLD: ["hold", "Held"],
    ESCALATE: ["escalate", "Review"],
    SCHEDULE: ["schedule", "Scheduled"],
    SETTLED: ["approved", "Settled"]
  };
  const [kind, label] = map[decision] || ["hold", decision || "Unknown"];
  return '<span class="status ' + kind + '">' + label + '</span>';
}

function renderStats() {
  const settled = state.invoices.filter((x) => x.settlement?.reconciled === true);
  const payable = state.invoices.filter((x) => x.agentDecision === "PAY_NOW" && !x.settlement?.reconciled);
  const held = state.invoices.filter((x) => !x.settlement?.reconciled && x.agentDecision !== "PAY_NOW");
  const total = payable.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  $("invoice-count").textContent = state.invoices.length;
  $("queue-count").textContent = state.invoices.length + (state.invoices.length === 1 ? " invoice" : " invoices");
  $("stats").innerHTML = [
    ["◎", "Ready to pay", total.toFixed(2) + " USDC", payable.length + " approved invoices"],
    ["◷", "Needs attention", String(held), "held or escalated"],
    ["✓", "Settled", String(settled.length), "reconciled on Arc"],
    ["⌁", "Execution", "Bounded", "contract-enforced limits"]
  ].map(([icon, label, value, meta]) =>
    '<div class="stat"><div class="stat-icon">' + icon + '</div><div><span>' + label +
    '</span><strong>' + value + '</strong><small>' + meta + '</small></div></div>'
  ).join("");
}

function renderList() {
  $("invoice-list").innerHTML = state.invoices.map((invoice) => {
    const selected = state.selected?.invoiceNumber === invoice.invoiceNumber ? " selected" : "";
    const displayDecision = invoice.settlement?.reconciled ? "SETTLED" : invoice.agentDecision;
    return '<button class="invoice-row' + selected + '" data-invoice="' +
      encodeURIComponent(invoice.invoiceNumber) + '"><div class="avatar">' +
      (invoice.vendor || "V").slice(0, 1) + '</div><div class="main"><div class="row-title"><strong>' +
      invoice.vendor + '</strong>' + status(displayDecision) + '</div><span class="sub">' +
      invoice.invoiceNumber + ' · due ' + invoice.dueDate + '</span></div><div class="amount">' +
      Number(invoice.amount || 0).toFixed(2) + ' ' + invoice.currency + '</div><span class="chev">›</span></button>';
  }).join("");

  document.querySelectorAll(".invoice-row").forEach((button) => {
    button.addEventListener("click", () => {
      const number = decodeURIComponent(button.dataset.invoice);
      state.selected = state.invoices.find((x) => x.invoiceNumber === number);
      renderList();
      renderDetail();
    });
  });
}

function renderDetail() {
  const invoice = state.selected;
  if (!invoice) return;
  const settled = invoice.settlement?.reconciled === true;
  const ready = invoice.agentDecision === "PAY_NOW" && !settled;
  const vendorInitial = (invoice.vendor || "V").slice(0, 1);
  $("detail").innerHTML = '<div class="detail-inner"><div class="detail-top"><div><label>INVOICE</label><h2>' +
    invoice.invoiceNumber + '</h2></div>' + status(settled ? "SETTLED" : invoice.agentDecision) + '</div>' +
    '<div class="merchant"><div class="avatar big">' + vendorInitial + '</div><div><strong>' +
    invoice.vendor + '</strong><span>' + invoice.currency + ' settlement · due ' + invoice.dueDate +
    '</span></div></div><div class="big-amount">' + Number(invoice.amount || 0).toFixed(2) +
    ' <span>' + invoice.currency + '</span></div><div class="decision"><div class="decision-head">● Agent reasoning</div><p>' +
    (settled ? "Payment executed and reconciled on Arc Mainnet." : invoice.decisionReasons?.[0] || "No decision reason recorded.") +
    '</p><div class="confidence"><span>Extraction confidence</span><b>' +
    (invoice.extraction?.confidence || "unknown") + '</b></div></div>' +
    '<div class="checks">' +
    checkRow("Required fields", "Complete") +
    checkRow("Currency rail", invoice.currency === "USDC" ? "USDC" : invoice.currency) +
    checkRow("Vendor registry", settled || ready ? "Verified" : "Check required") +
    checkRow("Payment policy", settled ? "Executed" : ready ? "Within limits" : "Blocked by policy") +
    '</div>' + (settled && invoice.settlement?.paymentTxHash ? '<div class="settlement"><span>Arc transaction</span><a href="https://explorer.arc.io/tx/' + invoice.settlement.paymentTxHash + '" target="_blank" rel="noreferrer">' + invoice.settlement.paymentTxHash.slice(0, 18) + '…</a><b>Reconciliation PASS</b></div>' : "") +
    '<button id="pay-button" class="pay"' + (ready ? "" : " disabled") +
    '>' + (ready ? "Settle invoice on Arc ↗" : settled ? "Settled on Arc ✓" : "Payment blocked") + '</button></div>';

  if (ready) $("pay-button").addEventListener("click", settle);
}

function checkRow(label, value) {
  const ok = value === "Complete" || value === "USDC" || value === "Verified" || value === "Within limits" || value === "Executed";
  return '<div class="check-row"><span class="' + (ok ? "check-ok" : "") + '">✓ ' + label +
    '</span><b>' + value + '</b></div>';
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => $("toast").hidden = true, 3200);
}

async function load() {
  state.loading = true;
  $("refresh").disabled = true;
  try {
    const response = await fetch("/api/invoices");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Invoice data unavailable");
    state.invoices = data.invoices || [];
    state.selected = state.selected
      ? state.invoices.find((x) => x.invoiceNumber === state.selected.invoiceNumber) || null
      : state.invoices[0] || null;
    renderStats();
    renderList();
    renderDetail();
  } catch (error) {
    toast(error.message);
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
  }
}

async function settle() {
  const invoice = state.selected;
  if (!invoice) return;
  $("pay-button").disabled = true;
  $("pay-button").textContent = "Executing…";
  try {
    const response = await fetch("/api/pay", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ invoiceNumber: invoice.invoiceNumber })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "Settlement failed");
    toast("Paid " + data.result.amount + " — " + data.result.paymentTxHash.slice(0, 10) + "…");
    $("pay-button").textContent = "Settled on Arc ✓";
  } catch (error) {
    toast(error.message);
    $("pay-button").disabled = false;
    $("pay-button").textContent = "Settle invoice on Arc ↗";
  }
}

$("refresh").addEventListener("click", () => {
  toast("Re-evaluating inbox…");
  load();
});

load();

