import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const state = {
  supabase: null,
  session: null,
  user: null,
  business: null,
  invoices: [],
  selected: null,
  feedSource: "gmail-live",
  gmail: null,
  wallet: null,
  policy: null,
  vendors: []
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

function showAuth() {
  $("auth-gate").hidden = false;
  $("app-shell").hidden = true;
}

function showApp() {
  $("auth-gate").hidden = true;
  $("app-shell").hidden = false;
}

function setAuthMessage(message, error = false) {
  const node = $("auth-message");
  node.textContent = message || "";
  node.className = "auth-message" + (error ? " error" : "");
}

async function authSubmit(event) {
  event.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const button = $("auth-submit");
  button.disabled = true;
  setAuthMessage("Signing in…");

  try {
    const { error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setAuthMessage("");
  } catch (error) {
    setAuthMessage(error.message || "Unable to sign in", true);
  } finally {
    button.disabled = false;
  }
}

async function signup() {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || password.length < 8) {
    setAuthMessage("Enter a valid company email and an 8+ character password.", true);
    return;
  }

  $("auth-signup").disabled = true;
  setAuthMessage("Creating your InboxPay account…");
  try {
    const { data, error } = await state.supabase.auth.signUp({
      email,
      password,
      options: { data: { business_name: email.split("@")[1] || "My Business" } }
    });
    if (error) throw error;
    if (!data.session) {
      setAuthMessage("Check your email to verify the account, then sign in.");
    } else {
      setAuthMessage("Account created.");
    }
  } catch (error) {
    setAuthMessage(error.message || "Unable to create account", true);
  } finally {
    $("auth-signup").disabled = false;
  }
}

async function authHeader() {
  const { data } = await state.supabase.auth.getSession();
  state.session = data.session;
  if (!state.session?.access_token) throw new Error("Your InboxPay session has expired.");
  return { Authorization: "Bearer " + state.session.access_token };
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}), ...(await authHeader()) };
  return fetch(path, { ...options, headers });
}

async function bootstrap() {
  showApp();
  const response = await apiFetch("/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Business onboarding failed");
  state.business = data.business;

  const sessionResponse = await apiFetch("/api/session");
  const session = await sessionResponse.json();
  if (sessionResponse.ok) state.gmail = session.gmail;

  const walletResponse = await apiFetch("/api/wallet");
  const wallet = await walletResponse.json();
  if (walletResponse.ok) state.wallet = wallet;

  await loadPolicyStatus();

  renderAccount();
  renderSetup();
  await load();
}

function shortAddress(address) {
  return address ? address.slice(0, 8) + "…" + address.slice(-6) : "Wallet provisioning…";
}

async function loadPolicyStatus() {
  try {
    const response = await apiFetch("/api/policy/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Policy status unavailable");
    state.business = data.business || state.business;
    state.policy = data.contract || null;
  } catch (error) {
    state.policy = null;
  }
}

function renderAccount() {
  $("business-name").textContent = state.business?.name || "Business";
  $("wallet-address").textContent = state.business?.wallet_address
    ? (state.business.wallet_blockchain || "Arc") + " · Circle wallet · " + shortAddress(state.business.wallet_address) +
      (state.wallet ? " · " + Number(state.wallet.balance || 0).toFixed(2) + " USDC" : "")
    : "Wallet provisioning…";
  $("connect-gmail").textContent = state.gmail?.status === "connected" ? "Gmail connected ✓" : "Connect Gmail";
  $("connect-gmail").disabled = state.gmail?.status === "connected";
  $("feed-label").textContent = state.gmail?.status === "connected" ? "live Gmail operator" : "connect Gmail";
  $("feed-dot").textContent = state.gmail?.status === "connected" ? "●" : "○";
}

function renderSetup() {
  const node = $("setup-card");
  const gmailReady = state.gmail?.status === "connected";
  const walletReady = state.business?.wallet_status === "ready";
  const policyReady = state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);

  if (gmailReady && walletReady && policyReady) {
    node.hidden = true;
    return;
  }

  node.hidden = false;
  node.innerHTML =
    '<div><label>SETUP</label><h3>Finish connecting your business</h3><p>' +
    (!walletReady ? "InboxPay is provisioning your dedicated Circle wallet. " : "") +
    (!gmailReady ? "Connect the Gmail inbox your business actually uses for invoices. " : "") +
    (!policyReady ? "Deploy the business policy guard before autonomous payments can run. " : "") +
    '</p></div><div class="setup-status">' +
    '<span class="' + (walletReady ? "done" : "") + '">✓ Dedicated Circle wallet</span>' +
    '<span class="' + (gmailReady ? "done" : "") + '">✓ Business Gmail</span>' +
    '<span class="' + (policyReady ? "done" : "") + '">✓ Onchain payment policy</span>' +
    (!policyReady
      ? '<button id="deploy-policy" class="ghost">' + (state.business?.policy_contract_status === "deploying" ? "Policy deployment running…" : "Deploy policy guard") + '</button>'
      : '<span class="setup-contract">Vault · ' + shortAddress(state.business.policy_contract_address) +
        (state.wallet?.policyVaultBalance != null ? " · " + Number(state.wallet.policyVaultBalance).toFixed(2) + " USDC" : "") +
        '</span>') +
    '</div>';

  if (!policyReady && state.business?.policy_contract_status !== "deploying") {
    $("deploy-policy").addEventListener("click", deployPolicy);
  }
}

async function deployPolicy() {
  const button = $("deploy-policy");
  if (button) {
    button.disabled = true;
    button.textContent = "Starting deployment…";
  }
  try {
    const response = await apiFetch("/api/policy/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (response.status === 409 && data.confirmation) {
      const ok = window.confirm(
        "Deploy InboxPay's policy vault on " + data.confirmation.network +
        "?\n\nWallet: " + data.confirmation.wallet +
        "\nToken: " + data.confirmation.token
      );
      if (!ok) return;
      const retry = await apiFetch("/api/policy/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmMainnet: true })
      });
      const retryData = await retry.json();
      if (!retry.ok) throw new Error(retryData.error || "Policy deployment failed");
      state.business = retryData.business || state.business;
    } else if (!response.ok) {
      throw new Error(data.error || "Policy deployment failed");
    } else {
      state.business = data.business || state.business;
    }

    toast("Policy guard deployment started");
    await loadPolicyStatus();
    renderAccount();
    renderSetup();
  } catch (error) {
    toast(error.message);
    await loadPolicyStatus();
    renderAccount();
    renderSetup();
  }
}

function renderStats() {
  const settled = state.invoices.filter((x) => x.settlement?.reconciled === true);
  const payable = state.invoices.filter((x) => x.agentDecision === "PAY_NOW" && !x.settlement?.reconciled);
  const held = state.invoices.filter((x) => !x.settlement?.reconciled && x.agentDecision !== "PAY_NOW");
  const total = payable.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  $("invoice-count").textContent = state.invoices.length;
  $("payment-count").textContent = settled.length;
  $("queue-count").textContent = state.invoices.length + (state.invoices.length === 1 ? " invoice" : " invoices");
  $("stats").innerHTML = [
    ["◎", "Ready to pay", total.toFixed(2) + " USDC", payable.length + " approved invoices"],
    ["◷", "Needs attention", String(held.length), "held or escalated"],
    ["✓", "Settled", String(settled.length), "reconciled on Arc"],
    ["⌁", "Execution", state.business?.wallet_status === "ready" ? "Dedicated" : "Provisioning", "business wallet"]
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
      (invoice.vendor || "Unknown vendor") + '</strong>' + status(displayDecision) + '</div><span class="sub">' +
      (invoice.invoiceNumber || "Missing invoice number") + ' · due ' + (invoice.dueDate || "not found") +
      '</span></div><div class="amount">' + Number(invoice.amount || 0).toFixed(2) + ' ' +
      (invoice.currency || "") + '</div><span class="chev">›</span></button>';
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
    (invoice.invoiceNumber || "Needs review") + '</h2></div>' + status(settled ? "SETTLED" : invoice.agentDecision) + '</div>' +
    '<div class="merchant"><div class="avatar big">' + vendorInitial + '</div><div><strong>' +
    (invoice.vendor || "Unknown vendor") + '</strong><span>' + (invoice.currency || "Unknown") +
    ' settlement · due ' + (invoice.dueDate || "not found") + '</span></div></div><div class="big-amount">' +
    Number(invoice.amount || 0).toFixed(2) + ' <span>' + (invoice.currency || "") + '</span></div><div class="decision"><div class="decision-head">● Agent reasoning</div><p>' +
    (settled ? "Payment executed and reconciled on Arc Mainnet." : invoice.decisionReasons?.[0] || "No decision reason recorded.") +
    '</p><div class="confidence"><span>Extraction confidence</span><b>' +
    (invoice.extraction?.confidence || "unknown") + '</b></div></div>' +
    '<div class="checks">' +
    checkRow("Required fields", invoice.invoiceNumber && invoice.amount !== null && invoice.dueDate ? "Complete" : "Review") +
    checkRow("Currency rail", invoice.currency || "Unknown") +
    checkRow("Vendor registry", ready || settled ? "Verified" : "Check required") +
    checkRow("Business wallet", state.business?.wallet_status === "ready" ? "Ready" : "Provisioning") +
    '</div>' + (settled ? '<div class="settlement"><span>Arc confirmation</span><b>Reconciliation PASS</b></div>' : "") +
    '<button id="pay-button" class="pay"' + (ready ? "" : " disabled") +
    '>' + (ready ? "Settle invoice on Arc ↗" : settled ? "Settled on Arc ✓" : "Payment blocked") + '</button></div>';

  if (ready) $("pay-button").addEventListener("click", settle);
}

function checkRow(label, value) {
  const ok = value === "Complete" || value === "USDC" || value === "Verified" || value === "Ready";
  return '<div class="check-row"><span class="' + (ok ? "check-ok" : "") + '">' + (ok ? "✓" : "○") + " " + label +
    '</span><b>' + value + '</b></div>';
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => $("toast").hidden = true, 3200);
}

async function openVendorModal() {
  $("vendor-modal").hidden = false;
  $("vendor-name").focus();
  await loadVendors();
}

async function loadVendors() {
  try {
    const response = await apiFetch("/api/vendors");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load vendors");
    state.vendors = data.vendors || [];
    renderVendors();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  }
}

function renderVendors() {
  const node = $("vendor-list");
  if (!state.vendors.length) {
    node.innerHTML = '<div class="vendor-empty">No vendor addresses registered yet.</div>';
    return;
  }
  node.innerHTML = state.vendors.map((vendor) =>
    '<div class="vendor-row"><div><strong>' + vendor.name + '</strong><span>' +
    vendor.recipient_address.slice(0, 10) + "…" + vendor.recipient_address.slice(-8) +
    '</span></div><div><b class="vendor-status ' + vendor.status + '">' + vendor.status + '</b>' +
    (vendor.status === "review"
      ? '<button class="ghost verify-vendor" data-id="' + vendor.id + '">Verify</button>'
      : "") +
    '</div></div>'
  ).join("");

  document.querySelectorAll(".verify-vendor").forEach((button) => {
    button.addEventListener("click", () => verifyVendor(button.dataset.id));
  });
}

async function verifyVendor(id) {
  try {
    const response = await apiFetch("/api/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "verified" })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to verify vendor");
    $("vendor-message").textContent = "Vendor verified. InboxPay can now consider matching invoices for payment.";
    $("vendor-message").className = "auth-message";
    await loadVendors();
    await load();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  }
}

function closeVendorModal() {
  $("vendor-modal").hidden = true;
}

async function addVendor(event) {
  event.preventDefault();
  const submit = $("vendor-submit");
  submit.disabled = true;
  $("vendor-message").textContent = "Saving vendor…";
  try {
    const response = await apiFetch("/api/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("vendor-name").value.trim(),
        recipientAddress: $("vendor-address").value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to add vendor");
    $("vendor-message").textContent = "Vendor added for review.";
    $("vendor-form").reset();
    await loadVendors();
    await load();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  } finally {
    submit.disabled = false;
  }
}

async function connectGmail() {
  try {
    const response = await apiFetch("/api/gmail/start");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to start Gmail connection");
    window.location.href = data.url;
  } catch (error) {
    toast(error.message);
  }
}

async function load() {
  if (!state.gmail?.status || state.gmail.status !== "connected") {
    state.invoices = [];
    state.selected = null;
    renderStats();
    renderList();
    $("detail").innerHTML = '<div class="empty"><div class="empty-icon">✉</div><h3>Connect the business inbox</h3><p>InboxPay only evaluates invoices from a real connected Gmail account.</p><button id="empty-connect" class="pay">Connect Gmail</button></div>';
    $("empty-connect").addEventListener("click", connectGmail);
    return;
  }

  $("refresh").disabled = true;
  try {
    const response = await apiFetch("/api/invoices");
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
    $("refresh").disabled = false;
  }
}

async function settle() {
  const invoice = state.selected;
  if (!invoice) return;
  $("pay-button").disabled = true;
  $("pay-button").textContent = "Executing…";
  try {
    const response = await apiFetch("/api/pay", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ invoiceNumber: invoice.invoiceNumber })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Settlement failed");
    toast("Payment submitted");
    await load();
  } catch (error) {
    toast(error.message);
    $("pay-button").disabled = false;
    $("pay-button").textContent = "Settle invoice on Arc ↗";
  }
}

async function init() {
  try {
    const configResponse = await fetch("/api/config");
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error || "InboxPay configuration unavailable");

    state.supabase = createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    $("auth-form").addEventListener("submit", authSubmit);
    $("auth-signup").addEventListener("click", signup);
    $("connect-gmail").addEventListener("click", connectGmail);
    $("add-vendor").addEventListener("click", openVendorModal);
    $("close-vendor").addEventListener("click", closeVendorModal);
    $("vendor-form").addEventListener("submit", addVendor);
    $("sign-out").addEventListener("click", async () => {
      await state.supabase.auth.signOut();
    });
    $("refresh").addEventListener("click", () => {
      toast("Syncing the business inbox…");
      load();
    });

    state.supabase.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (event === "SIGNED_OUT") {
        state.user = null;
        state.business = null;
        state.gmail = null;
        state.wallet = null;
        state.policy = null;
        showAuth();
        return;
      }
      if (event === "SIGNED_IN" && session) {
        state.user = session.user;
        bootstrap().catch((error) => toast(error.message));
      }
    });

    const { data } = await state.supabase.auth.getSession();
    state.session = data.session;

    if (!state.session) {
      showAuth();
      return;
    }

    state.user = state.session.user;
    await bootstrap();

    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") {
      toast("Business Gmail connected");
      history.replaceState({}, "", "/");
    } else if (params.get("gmail") === "error") {
      toast(params.get("message") || "Gmail connection failed");
      history.replaceState({}, "", "/");
    }
  } catch (error) {
    showAuth();
    setAuthMessage(error.message || "InboxPay failed to initialize", true);
  }
}

init();
