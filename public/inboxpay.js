import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activateDestination, auditEventCategory, auditEventLabel, destinationFromHash, inboxFailurePresentation, invoiceQueueCategory, networkLabel, paymentFlowStep, singleFlight } from "./ui-state.mjs";
import { createDialog } from "./dialog.js";
import { businessNameNeedsReview } from "./ui-state.mjs";

const state = {
  supabase: null,
  previewReadOnly: false,
  businessNameRequired: false,
  bootstrapError: false,
  session: null,
  user: null,
  business: null,
  invoices: [],
  inboxStatus: "idle",
  selected: null,
  gmail: null,
  wallet: null,
  policy: null,
  policyConfig: null,
  onchainPolicy: null,
  policyAllowance: false,
  policyStatusError: null,
  policyConfigError: null,
  vendors: [],
  vendorsError: null,
  vendorRevocationSupported: null,
  preflight: null,
  preflightLoading: false,
  withdrawalRequestId: null,
  notification: null,
  queue: { filter: "all", query: "" },
  activity: { kind: null, rows: [], data: null, filter: "all", query: "" }
};

let bootstrapPromise = null;
let activeDestination = "inbox";
let activityRequestId = 0;

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const body = text.replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(
      "InboxPay server error (" + response.status + "): " +
      (body || response.statusText || "Unexpected non-JSON response")
    );
  }
}

const $ = (id) => document.getElementById(id);
const invoiceDrawer = createDialog($("invoice-drawer"), {
  resolveOpener: () => [...document.querySelectorAll("[data-invoice]")].find((row) =>
    decodeURIComponent(row.dataset.invoice) === state.selected?.invoiceNumber
  ) || $("queue-search")
});
const authDialog = createDialog($("auth-dialog"));
document.querySelectorAll("[data-auth-open]").forEach((button) => button.addEventListener("click", () => authDialog.open(button)));
$("auth-close").addEventListener("click", () => authDialog.close());
$("close-invoice").addEventListener("click", () => invoiceDrawer.close());
const navigationPaths = {
  inbox: '<path d="M4 4h16v16H4zM4 13h5l2 3h2l2-3h5"/>',
  payments: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  policy: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  audit: '<path d="M8 5h12M8 12h12M8 19h12M3 5h1M3 12h1M3 19h1"/>',
  business: '<path d="M5 21V5l7-2 7 2v16M3 21h18M9 8h1m4 0h1M9 12h1m4 0h1M10 21v-5h4v5"/>',
  vendors: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0112 0v3M16 5a3 3 0 010 6M18 15a5 5 0 013 4v2"/>',
  notifications: '<path d="M5 17h14l-2-3V9a5 5 0 00-10 0v5l-2 3ZM10 21h4"/>'
};
document.querySelectorAll("[data-icon]").forEach((node) => {
  node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + navigationPaths[node.dataset.icon] + '</svg>';
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function invoiceSettled(invoice) {
  return invoice?.settlement?.status === "confirmed" ||
    invoice?.settlement?.reconciled === true ||
    invoice?.settlement?.onchainDuplicate === true;
}

function preflightSettled(preflight) {
  return (preflight?.checks || []).some((check) =>
    check.key === "settlement_state" && check.value === "Already settled"
  );
}

function status(decision) {
  const map = {
    PAY_NOW: ["approved", "Pay now"],
    HOLD: ["hold", "Held"],
    ESCALATE: ["escalate", "Review"],
    SCHEDULE: ["schedule", "Scheduled"],
    SCHEDULED: ["schedule", "Queued"],
    SETTLED: ["approved", "Settled"],
    PROCESSING: ["schedule", "Processing"],
    FAILED: ["escalate", "Retry"],
    CHECKING: ["schedule", "Checking"],
    REVIEW: ["escalate", "Review"]
  };
  const [kind, label] = map[decision] || ["hold", decision || "Unknown"];
  return '<span class="status ' + escapeHtml(kind) + '">' + escapeHtml(label) + '</span>';
}

function showAuth() {
  invoiceDrawer.close();
  setDestination("inbox", false);
  $("skip-link").hidden = true;
  $("auth-gate").hidden = false;
  $("app-shell").hidden = true;
  document.title = "InboxPay — Payments, straight from your inbox";
}

function showApp() {
  authDialog.close();
  for (const id of ["signed-in-email", "signed-in-email-mobile"]) $(id).textContent = state.user?.email || state.session?.user?.email || "Checking account…";
  $("auth-gate").hidden = true;
  $("app-shell").hidden = false;
  $("skip-link").hidden = false;
}

function pageMetric(label, value, note, tone = "") {
  return '<article class="page-metric ' + escapeHtml(tone) + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(note) + '</small></article>';
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
      options: {
        emailRedirectTo: window.location.origin + "/"
      }
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

async function signInWithGoogle() {
  const button = $("auth-google");
  if (button) button.disabled = true;
  setAuthMessage("Opening Google sign in…");

  try {
    const { data, error } = await state.supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + "/"
      }
    });
    if (error) throw error;
    if (data?.url) window.location.assign(data.url);
  } catch (error) {
    setAuthMessage(error.message || "Unable to continue with Google", true);
    if (button) button.disabled = false;
  }
}

async function authHeader() {
  const { data } = await state.supabase.auth.getSession();
  state.session = data.session;
  if (!state.session?.access_token) throw new Error("Your InboxPay session has expired.");
  return { Authorization: "Bearer " + state.session.access_token };
}

async function apiFetch(path, options = {}) {
  const body = options.body ? JSON.parse(options.body) : {};
  if (state.previewReadOnly && options.method && options.method !== "GET" && !(path === "/api/onboarding" && options.method === "POST" && body.action === "approve" && body.businessName === undefined)) {
    throw new Error("This QA preview cannot change account settings or move funds.");
  }
  const headers = { ...(options.headers || {}), ...(await authHeader()) };
  return fetch(path, { ...options, headers });
}

async function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    showApp();
    state.bootstrapError = false;
    $("bootstrap-notice").hidden = true;

    const response = await apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Business onboarding failed");
    state.business = data.business;
    state.businessNameRequired = data.onboarding?.businessNameRequired === true;
    if (state.businessNameRequired) {
      state.invoices = [];
      state.inboxStatus = "idle";
      renderAccount();
      renderSetup();
      $("feed-label").textContent = "Business setup needed";
      $("feed-meta").textContent = "Choose your business name before connecting an inbox.";
      $("queue-count").textContent = "Setup needed";
      $("invoice-list").innerHTML = '<div class="empty queue-empty"><h3>Your inbox starts here</h3><p>Set up your business above. Then connect the Gmail inbox that receives your invoices.</p></div>';
      $("stats").innerHTML = "";
      return;
    }

    const sessionResponse = await apiFetch("/api/session");
    const session = await readJsonResponse(sessionResponse);
    if (sessionResponse.ok) state.gmail = session.gmail;

    const walletResponse = await apiFetch("/api/wallet");
    const wallet = await readJsonResponse(walletResponse);
    if (walletResponse.ok) state.wallet = wallet;

    await Promise.all([loadPolicyStatus(), loadPolicyConfig(), loadVendors()]);

    renderAccount();
    renderSetup();
    await load();
  })();

  try {
    return await bootstrapPromise;
  } catch (error) {
    state.bootstrapError = true;
    renderBootstrapFailure();
    throw error;
  } finally {
    bootstrapPromise = null;
  }
}

function renderBootstrapFailure() {
  $("bootstrap-notice").hidden = false;
  $("setup-card").hidden = true;
  $("stats").innerHTML = "";
  for (const id of ["invoice-count", "payment-count"]) $(id).textContent = "—";
  $("queue-count").textContent = "Unavailable";
  $("feed-label").textContent = "Workspace unavailable";
  $("feed-meta").textContent = "Business records could not be loaded. Use Retry workspace.";
  $("invoice-list").innerHTML = '<div class="empty queue-empty"><h3>We couldn’t load your workspace</h3><p>This is not an empty-workspace result. Retry to load your saved business records.</p></div>';
}

function shortAddress(address) {
  return address ? address.slice(0, 8) + "…" + address.slice(-6) : "Wallet provisioning…";
}

async function copyText(value, label) {
  await navigator.clipboard.writeText(value);
  toast(label + " copied");
}

async function loadPolicyStatus() {
  try {
    const response = await apiFetch("/api/policy?view=status");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Policy status unavailable");
    state.business = data.business || state.business;
    state.policy = data.contract || null;
    state.onchainPolicy = data.onchainPolicy || null;
    state.policyAllowance = data.allowance ? BigInt(data.allowance) > 0n : false;
    state.policyStatusError = null;
  } catch (error) {
    state.policy = null;
    state.onchainPolicy = null;
    state.policyStatusError = error.message || "Live policy status unavailable";
  }
}

async function loadPolicyConfig() {
  try {
    const response = await apiFetch("/api/policy");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Policy configuration unavailable");
    state.policyConfig = data.policy || null;
    state.policyConfigError = null;
  } catch (error) {
    state.policyConfig = null;
    state.policyConfigError = error.message || "Policy configuration unavailable";
  }
}

function renderExecutionRail() {
  const walletState = $("rail-wallet-state");
  if (!walletState) return;

  const walletStatus = state.business?.wallet_status;
  walletState.textContent = walletStatus === "ready"
    ? "Ready"
    : walletStatus === "provisioning" || walletStatus === "creating"
      ? "Provisioning"
      : walletStatus === "error" || walletStatus === "failed"
        ? "Needs attention"
        : "Not provisioned";

  const balance = state.wallet?.balance;
  $("rail-wallet-balance").textContent = balance != null && Number.isFinite(Number(balance))
    ? Number(balance).toFixed(2) + " USDC"
    : "Unavailable";

  const vaultState = $("rail-vault-state");
  if (state.policyStatusError) {
    vaultState.textContent = "Status unavailable";
  } else if (state.business?.policy_contract_status === "ready" && state.business?.policy_contract_address) {
    vaultState.textContent = state.onchainPolicy?.paused ? "Deployed · paused" : "Deployed";
  } else if (state.business?.policy_contract_status === "deploying") {
    vaultState.textContent = "Deploying";
  } else {
    vaultState.textContent = "Not deployed";
  }

  $("rail-allowance-state").textContent = state.policyStatusError
    ? "Status unavailable"
    : state.policyAllowance
      ? "Authorized"
      : "Not authorized";

  const activeNetwork = state.business?.active_network || state.business?.wallet_blockchain || "ARC-TESTNET";
  $("network-label-rail").textContent = networkLabel(activeNetwork);
  renderPaymentFlow();
}

function renderPaymentFlow() {
  const currentStep = paymentFlowStep(state);
  document.querySelectorAll("[data-flow-step]").forEach((item) => {
    const step = Number(item.dataset.flowStep);
    item.classList.toggle("flow-current", currentStep === step);
    item.classList.toggle("flow-complete", currentStep > step);
    if (currentStep === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
}

function renderAccount() {
  for (const id of ["signed-in-email", "signed-in-email-mobile"]) $(id).textContent = state.user?.email || "Account unavailable";
  for (const id of ["open-payments", "open-policy", "open-audit", "nav-business", "nav-vendors", "nav-notifications", "refresh", "connect-gmail", "network-switch"]) {
    $(id).disabled = state.businessNameRequired || (state.bootstrapError && !state.business) || (state.previewReadOnly && ["connect-gmail", "network-switch"].includes(id));
  }
  renderExecutionRail();
  $("business-name").textContent = state.business?.name || "Business";
  $("business-summary-name").textContent = state.business?.name || "Your business account";
  const activeNetwork = state.business?.active_network || state.business?.wallet_blockchain || "ARC-TESTNET";
  const activeNetworkLabel = networkLabel(activeNetwork);
  $("network-label").textContent = activeNetworkLabel;
  $("network-label-rail").textContent = activeNetworkLabel;
  $("footer-network").textContent = activeNetworkLabel;
  document.body.dataset.network = activeNetwork;
  const networkSwitch = $("network-switch");
  const accounts = state.business?.network_accounts || [];
  for (const option of networkSwitch.options) {
    const account = accounts.find((entry) => entry.network === option.value);
    const label = option.value === "ARC" ? "Arc Mainnet" : "Arc Testnet";
    option.textContent = label + " · " + (account?.wallet_status === "ready" ? "Ready" : "Set up");
  }
  networkSwitch.value = activeNetwork;
  const walletAddress = state.business?.wallet_address;
  const walletStatus = state.business?.wallet_status;
  const walletReady = walletStatus === "ready" && Boolean(walletAddress);
  const walletStatusLabel = walletReady
    ? "Circle wallet ready"
    : walletStatus === "provisioning" || walletStatus === "creating"
      ? "Wallet provisioning"
      : walletStatus === "error" || walletStatus === "failed"
        ? "Wallet needs attention"
        : "Wallet not provisioned";
  $("wallet-address").textContent = walletAddress || "No wallet provisioned for this environment";
  $("wallet-address").classList.toggle("is-unavailable", !walletAddress);
  $("wallet-network").textContent = (state.business?.wallet_blockchain || activeNetwork) + " · Circle wallet";
  $("wallet-status").textContent = walletStatusLabel;
  $("wallet-status").dataset.state = walletReady ? "ready" : walletStatus === "error" || walletStatus === "failed" ? "error" : "pending";
  $("wallet-balance").textContent = state.wallet?.balance != null && Number.isFinite(Number(state.wallet.balance))
    ? Number(state.wallet.balance).toFixed(2) + " USDC"
    : "Unavailable";
  $("copy-wallet").hidden = !walletAddress;
  const gmailConnected = state.gmail?.status === "connected";
  const gmailNeedsReconnect = state.gmail?.status === "reauthorization_required";
  $("connect-gmail").textContent = gmailNeedsReconnect ? "Reconnect Gmail" : "Connect Gmail";
  $("connect-gmail").hidden = gmailConnected;
  $("connect-gmail").disabled = state.businessNameRequired || state.previewReadOnly || state.bootstrapError;
  $("feed-label").textContent = gmailConnected ? "Gmail connected" : gmailNeedsReconnect ? "Reconnect required" : "Connect business Gmail";
  $("feed-state").dataset.state = gmailConnected ? "connected" : gmailNeedsReconnect ? "reauthorization" : "disconnected";
  $("feed-dot").textContent = gmailConnected ? "●" : "○";
  renderBusinessPage();
  if (state.bootstrapError) renderBootstrapFailure();
}

function renderBusinessPage() {
  const summary = $("business-snapshot");
  const details = $("business-rail-details");
  if (!summary || !details || !state.business) return;
  const network = state.business?.active_network || state.business?.wallet_blockchain || "ARC-TESTNET";
  const walletReady = state.business?.wallet_status === "ready" && Boolean(state.business?.wallet_address);
  const policyReady = state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);
  const gmailReady = state.gmail?.status === "connected";
  summary.innerHTML = [
    pageMetric("Environment", networkLabel(network), "Network-isolated account", network === "ARC" ? "mainnet" : "testnet"),
    pageMetric("Business wallet", walletReady ? "Ready" : "Setup needed", walletReady ? "Dedicated Circle wallet" : "No wallet for this environment", walletReady ? "ready" : "attention"),
    pageMetric("Policy vault", policyReady ? "Enforced" : "Setup needed", policyReady ? "Dedicated onchain guard" : "No active vault", policyReady ? "ready" : "attention"),
    pageMetric("Invoice source", state.previewReadOnly ? "Saved records" : gmailReady ? "Connected" : "Disconnected", state.previewReadOnly ? "No new inbox scan in preview" : gmailReady ? "Live Gmail evaluation" : "Reconnect Gmail", gmailReady ? "ready" : "attention")
  ].join("");
  $("business-network-badge").textContent = networkLabel(network);
  const walletAddress = state.business?.wallet_address || "Not provisioned";
  const vaultAddress = state.business?.policy_contract_address || "Not deployed";
  details.innerHTML =
    '<div><span>Dedicated wallet</span><strong>' + escapeHtml(walletAddress) + '</strong>' +
      (walletReady ? '<button class="text-action copy-business-address" type="button" data-address="' + escapeHtml(walletAddress) + '" data-label="Business wallet address">Copy address</button>' : '') + '</div>' +
    '<div><span>Policy vault</span><strong>' + escapeHtml(vaultAddress) + '</strong>' +
      (policyReady ? '<button class="text-action copy-business-address" type="button" data-address="' + escapeHtml(vaultAddress) + '" data-label="Policy vault address">Copy address</button>' : '') + '</div>' +
    '<div><span>Wallet balance</span><strong>' + (state.wallet ? escapeHtml(Number(state.wallet.balance || 0).toFixed(2) + " USDC") : "Unavailable") + '</strong></div>';
  document.querySelectorAll(".copy-business-address").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.address, button.dataset.label));
  });

  const withdrawalSummary = $("withdrawal-summary");
  const withdrawalHistory = $("withdrawal-history");
  const withdrawalSubmit = $("withdrawal-submit");
  if (!withdrawalSummary || !withdrawalHistory || !withdrawalSubmit) return;
  const wallet = state.wallet;
  withdrawalSummary.innerHTML = [
    ["Wallet balance", wallet ? Number(wallet.balance || 0).toFixed(6) + " USDC" : "Unavailable"],
    ["Cash floor", wallet ? Number(wallet.cashFloor || 0).toFixed(6) + " USDC" : "Unavailable"],
    ["Reserved", wallet ? Number(wallet.reserved || 0).toFixed(6) + " USDC" : "Unavailable"],
    ["Withdrawable", wallet ? Number(wallet.withdrawable || 0).toFixed(6) + " USDC" : "Unavailable"]
  ].map(([label, value]) => '<div><span>' + label + '</span><strong>' + escapeHtml(value) + '</strong></div>').join("");
  withdrawalSubmit.disabled = !walletReady || !wallet || Number(wallet.withdrawable || 0) <= 0;
  withdrawalSubmit.textContent = withdrawalSubmit.disabled ? "No withdrawable funds" : "Review withdrawal";
  const withdrawals = wallet?.withdrawals || [];
  withdrawalHistory.innerHTML = withdrawals.length
    ? withdrawals.map((withdrawal) => {
        const explorer = withdrawal.network === "ARC" ? "https://arcscan.app/tx/" : "https://testnet.arcscan.app/tx/";
        return '<article class="withdrawal-record"><div><strong>' + escapeHtml(Number(withdrawal.amount || 0).toFixed(6) + " USDC") + '</strong>' +
          '<code>' + escapeHtml(withdrawal.recipientAddress) + '</code><span>' + escapeHtml(new Date(withdrawal.createdAt).toLocaleString()) +
          (withdrawal.error ? " · " + escapeHtml(withdrawal.error) : "") + '</span></div><div><b>' + escapeHtml(withdrawal.status) + '</b>' +
          (withdrawal.transactionHash ? '<a href="' + explorer + encodeURIComponent(withdrawal.transactionHash) + '" target="_blank" rel="noreferrer">Receipt ↗</a>' : '<span>Receipt pending</span>') +
          '</div></article>';
      }).join("")
    : '<div class="empty compact"><h3>No withdrawals</h3><p>Confirmed business-wallet transfers will appear here with their Arc receipts.</p></div>';
}

function renderSetup() {
  const node = $("setup-card");
  if (state.bootstrapError) { node.hidden = true; return; }
  if (state.businessNameRequired || businessNameNeedsReview(state.business, state.user?.email)) {
    node.hidden = false;
    node.innerHTML = '<div class="setup-copy"><label>FIRST, YOUR BUSINESS</label><h3>What’s your business called?</h3><p>Use the name you want on your workspace and payment records. This does not create a wallet or authorize payments.</p></div>' +
      '<form id="business-identity-form" class="identity-setup-form"><label for="initial-business-name">Business name</label><input id="initial-business-name" name="businessName" type="text" minlength="2" maxlength="80" required autocomplete="organization" placeholder="e.g. North Studio" aria-describedby="identity-setup-message"' + (state.previewReadOnly ? ' disabled' : '') + '>' +
      '<button type="submit" class="primary"' + (state.previewReadOnly ? ' disabled' : '') + '>Save business name</button><p id="identity-setup-message" role="status" aria-live="polite">' + (state.previewReadOnly ? 'Naming is disabled in this read-only preview. Your saved business has not changed.' : 'You can update this later in Business account.') + '</p></form>';
    $("business-identity-form").addEventListener("submit", saveInitialBusinessName);
    return;
  }
  const gmailReady = state.gmail?.status === "connected";
  const walletReady = state.business?.wallet_status === "ready";
  const walletFunded = Number(state.wallet?.balance || 0) > 0;
  const testnetNeedsFunding = walletReady && state.business?.wallet_blockchain === "ARC-TESTNET" && !walletFunded;
  const policyReady = state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);
  const policyUnavailable = Boolean(state.policyStatusError);
  const step = (label, stepState) => {
    const icon = stepState === "done" ? "✓" : stepState === "error" ? "!" : "○";
    return '<span class="setup-step ' + stepState + '"><i aria-hidden="true">' + icon + '</i>' + escapeHtml(label) + '</span>';
  };

  if (gmailReady && walletReady && policyReady && !policyUnavailable) {
    node.hidden = true;
    return;
  }

  const setupTitle = policyUnavailable && walletReady
    ? "Policy status needs attention"
    : "Finish connecting your business";
  const setupCopy = !walletReady
    ? "Create the dedicated Circle wallet that will hold this business's USDC."
    : !gmailReady
      ? "Connect the Gmail inbox your business actually uses for invoices."
      : testnetNeedsFunding
        ? "Fund the Arc Testnet wallet so it can pay deployment gas."
        : policyUnavailable
          ? "InboxPay could not confirm the live policy vault. Review the policy status before taking any payment action."
      : "Set your payment limits, then review and activate payments for this business.";

  node.hidden = false;
  node.innerHTML =
    '<div class="setup-copy"><label>GETTING STARTED</label><h3>' + escapeHtml(setupTitle) + '</h3><p>' + escapeHtml(setupCopy) +
    '</p></div><div class="setup-status">' +
    step("Business wallet", walletReady ? "done" : "pending") +
    (!walletReady
      ? '<span>Selected environment · ' + (state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet") + '</span><button id="provision-wallet" class="ghost">Create dedicated wallet</button>'
      : '') +
    (testnetNeedsFunding ? '<button id="fund-test-wallet" class="ghost">Fund test wallet</button>' : '') +
    step("Business Gmail", gmailReady ? "done" : "pending") +
    step(policyUnavailable ? "Payment settings unavailable" : "Payment settings", policyUnavailable ? "error" : policyReady ? "done" : "pending") +
    (walletReady && (policyUnavailable || !policyReady)
      ? '<button id="setup-policy" class="ghost"' + (testnetNeedsFunding || state.business?.policy_contract_status === "deploying" ? ' disabled' : '') + '>' +
        (testnetNeedsFunding ? "Fund wallet first" : state.business?.policy_contract_status === "deploying" ? "Policy deployment running…" : policyUnavailable ? "Review policy status" : "Review policy & deploy") + '</button>'
      : policyReady
        ? '<span class="setup-contract">Vault · ' + shortAddress(state.business.policy_contract_address) +
          (state.wallet?.policyVaultBalance != null ? " · Business wallet balance: " + Number(state.wallet.policyVaultBalance).toFixed(2) + " USDC" : "") +
          '</span>'
        : '') +
    '</div>';

  if (!walletReady) $("provision-wallet").addEventListener("click", provisionWallet);
  if (testnetNeedsFunding) $("fund-test-wallet").addEventListener("click", fundTestWallet);
  if (walletReady && (policyUnavailable || !policyReady) && !testnetNeedsFunding && state.business?.policy_contract_status !== "deploying") {
    $("setup-policy").addEventListener("click", openPolicyModal);
  }
}

async function saveInitialBusinessName(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const input = $("initial-business-name");
  const button = form.querySelector('button[type="submit"]');
  const message = $("identity-setup-message");
  const businessName = input.value.trim();
  button.disabled = true;
  button.textContent = "Saving…";
  message.textContent = "Saving your business name…";
  try {
    const response = await apiFetch("/api/onboarding", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.business ? { action: "rename_business", name: businessName } : { action: "approve", businessName })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.business) throw new Error(data.error || "Business name could not be saved. Please try again.");
    await bootstrap();
    toast("Business name saved");
  } catch (error) {
    message.textContent = error.message || "Business name could not be saved. Please try again.";
    input.focus();
  } finally {
    button.disabled = state.previewReadOnly;
    button.textContent = "Save business name";
  }
}

async function fundTestWallet() {
  const button = $("fund-test-wallet");
  button.disabled = true;
  button.textContent = "Requesting test funds…";

  try {
    const response = await apiFetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fund_testnet", network: state.business?.wallet_blockchain })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Testnet funding failed");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
      const walletResponse = await apiFetch("/api/wallet");
      const walletData = await readJsonResponse(walletResponse);
      if (walletResponse.ok) state.wallet = walletData;
      if (Number(state.wallet?.balance || 0) > 0) break;
    }

    renderAccount();
    renderSetup();
    toast(Number(state.wallet?.balance || 0) > 0 ? "Arc Testnet wallet funded" : "Testnet funding requested; balance is pending");
  } catch (error) {
    toast(error.message || "Testnet funding failed");
    renderSetup();
  }
}

async function provisionWallet() {
  const network = state.business?.active_network || state.business?.wallet_blockchain || "ARC-TESTNET";
  if (network === "ARC") {
    const ok = window.confirm(
      "Create this business's dedicated Circle wallet on Arc Mainnet?\\n\\n" +
      "This creates the wallet only; no USDC is moved."
    );
    if (!ok) return;
  }

  const button = $("provision-wallet");
  button.disabled = true;
  button.textContent = "Creating wallet…";

  try {
    const response = await apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "provision_wallet",
        network,
        ...(network === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Wallet creation failed");

    state.business = data.business || state.business;
    await loadPolicyStatus();

    const walletResponse = await apiFetch("/api/wallet");
    const walletData = await readJsonResponse(walletResponse);
    if (walletResponse.ok) state.wallet = walletData;

    renderAccount();
    renderSetup();
    toast("Dedicated business wallet ready");
  } catch (error) {
    toast(error.message || "Wallet creation failed");
    renderSetup();
  }
}

function resetNetworkState() {
  invoiceDrawer.close();
  state.inboxStatus = "idle";
  state.invoices = [];
  state.selected = null;
  state.wallet = null;
  state.policy = null;
  state.policyConfig = null;
  state.onchainPolicy = null;
  state.policyAllowance = false;
  state.policyStatusError = null;
  state.policyConfigError = null;
  state.vendors = [];
  state.vendorRevocationSupported = null;
  state.preflight = null;
  state.preflightLoading = false;
  state.queue = { filter: "all", query: "" };
  state.activity = { kind: null, rows: [], filter: "all", query: "" };
}

async function switchNetwork(event) {
  const select = event.currentTarget;
  const previous = state.business?.active_network || state.business?.wallet_blockchain || "ARC-TESTNET";
  const network = select.value;
  let changed = false;
  if (network === previous) return;

  if (network === "ARC" && !window.confirm(
    "Enter this business's Arc Mainnet environment?\n\n" +
    "Mainnet has a separate Circle wallet, policy vault, vendors, invoices, and audit trail. Switching environments does not move funds or submit a payment."
  )) {
    select.value = previous;
    return;
  }

  select.disabled = true;
  try {
    const response = await apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "select_network",
        network,
        ...(network === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to switch environments");
    resetNetworkState();
    state.business = data.business;
    changed = true;
    await bootstrap();
    toast((network === "ARC" ? "Arc Mainnet" : "Arc Testnet") + " environment active");
  } catch (error) {
    if (!changed) select.value = previous;
    else {
      renderAccount();
      renderSetup();
    }
    toast(error.message || "Unable to switch environments");
  } finally {
    select.disabled = false;
  }
}

function policyIsReady() {
  return state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);
}

function invoicePaymentReady(invoice) {
  const vendor = state.vendors.find((item) => item.name === invoice.vendor);
  const paused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  return invoice.agentDecision === "PAY_NOW" &&
    !invoiceSettled(invoice) &&
    invoice.settlement?.status !== "processing" &&
    invoice.settlement?.status !== "review" &&
    invoice.settlement?.status !== "scheduled" &&
    policyIsReady() &&
    state.policyAllowance &&
    !paused &&
    vendor?.status === "verified" &&
    vendor?.onchain_status === "registered";
}

async function openBusinessModal(options = {}) {
  setDestination("business", options.updateUrl !== false);
  $("business-name-input").value = state.business?.name || "";
  $("business-message").textContent = "";
  $("business-message").className = "auth-message";
  renderBusinessPage();
  try {
    const response = await apiFetch("/api/wallet");
    const data = await readJsonResponse(response);
    if (response.ok) {
      state.wallet = data;
      renderBusinessPage();
    }
  } catch {}
  $("business-name-input").focus();
}

function closeBusinessModal() {
  setDestination("inbox");
  $("business-message").textContent = "";
}

function renderNotifications() {
  if (state.previewReadOnly) {
    $("notification-status").textContent = "Not checked in preview";
    $("notification-status").className = "";
    $("notification-description").textContent = "Your saved Telegram connection is unchanged. Connection status and delivery tests are available in the live app.";
    for (const id of ["notification-destination", "notification-connect", "notification-test", "notification-disconnect", "notification-refresh"]) $(id).hidden = true;
    return;
  }
  const notification = state.notification || { status: "not_connected" };
  const connected = notification.status === "connected";
  $("notification-status").textContent = connected ? "Connected" : "Not connected";
  $("notification-status").className = connected ? "ready" : "";
  $("notification-description").textContent = connected
    ? "Telegram is linked for this business's payment alerts. Platform incidents are handled by InboxPay operators."
    : "Link your Telegram chat without sharing a bot token with InboxPay.";
  $("notification-destination").hidden = !connected;
  $("notification-destination").textContent = connected
    ? `${notification.destinationHint || "Telegram destination"} · ${notification.chatType || "chat"}${notification.lastTestedAt ? " · tested " + new Date(notification.lastTestedAt).toLocaleString() : ""}`
    : "";
  $("notification-connect").hidden = connected;
  $("notification-test").hidden = !connected;
  $("notification-disconnect").hidden = !connected;
}

async function loadNotifications() {
  if (state.previewReadOnly) {
    $("notifications-message").textContent = "Telegram settings are unavailable in this read-only preview.";
    $("notifications-message").className = "auth-message";
    renderNotifications();
    return;
  }
  $("notifications-message").textContent = "Checking Telegram connection…";
  $("notifications-message").className = "auth-message";
  const response = await apiFetch("/api/activity?view=notifications");
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || "Telegram notification status unavailable");
  state.notification = data.notification;
  $("notifications-message").textContent = "";
  renderNotifications();
}

async function openNotifications(options = {}) {
  setDestination("notifications", options.updateUrl !== false);
  renderNotifications();
  try { await loadNotifications(); }
  catch (error) { $("notifications-message").textContent = error.message; $("notifications-message").className = "auth-message error"; }
}

async function notificationAction(action, body = {}) {
  const response = await apiFetch("/api/activity?view=notifications", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body })
  });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || "Telegram notification action failed");
  return data;
}

async function connectTelegram() {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  const button = $("notification-connect");
  button.disabled = true;
  $("notifications-message").textContent = "Creating a secure one-time Telegram link…";
  $("notifications-message").className = "auth-message";
  try {
    const data = await notificationAction("begin_telegram_link");
    if (popup) popup.location = data.link.url;
    else window.location.assign(data.link.url);
    $("notifications-message").textContent = "In Telegram, press Start. Then return here and refresh status. This link expires in 10 minutes.";
  } catch (error) {
    popup?.close();
    $("notifications-message").textContent = error.message;
    $("notifications-message").className = "auth-message error";
  } finally { button.disabled = false; }
}

async function testTelegramNotification() {
  $("notification-test").disabled = true;
  try { await notificationAction("send_test"); await loadNotifications(); toast("Test message sent to this business"); }
  catch (error) { toast(error.message); }
  finally { $("notification-test").disabled = false; }
}

async function disconnectTelegram() {
  if (!window.confirm("Disconnect this business's Telegram destination?")) return;
  try { const data = await notificationAction("disconnect"); state.notification = data.notification; renderNotifications(); toast("Telegram disconnected"); }
  catch (error) { toast(error.message); }
}

async function saveBusinessName(event) {
  event.preventDefault();
  const submit = $("business-submit");
  submit.disabled = true;
  $("business-message").textContent = "Saving business name…";
  $("business-message").className = "auth-message";
  try {
    const response = await apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename_business", name: $("business-name-input").value })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Business name update failed");
    state.business = data.business || state.business;
    renderAccount();
    closeBusinessModal();
    toast("Business name updated");
  } catch (error) {
    $("business-message").textContent = error.message || "Business name update failed";
    $("business-message").className = "auth-message error";
  } finally {
    submit.disabled = false;
  }
}

async function submitWalletWithdrawal(event) {
  event.preventDefault();
  const recipientAddress = $("withdrawal-recipient").value.trim();
  const amount = $("withdrawal-amount").value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
    $("withdrawal-message").textContent = "Enter a valid Arc recipient address.";
    $("withdrawal-message").className = "auth-message error";
    return;
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    $("withdrawal-message").textContent = "Enter a positive USDC amount with no more than six decimals.";
    $("withdrawal-message").className = "auth-message error";
    return;
  }
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const confirmed = window.confirm(
    "Withdraw " + Number(amount).toFixed(6) + " USDC on " + network + "?\n\n" +
    "From: " + state.business.wallet_address + "\n" +
    "To: " + recipientAddress + "\n\n" +
    "InboxPay will preserve the " + Number(state.wallet?.cashFloor || 0).toFixed(6) + " USDC cash floor, " +
    Number(state.wallet?.reserved || 0).toFixed(6) + " USDC in autonomous-payment reservations, and the estimated network fee. " +
    "Verify the address carefully; confirmed onchain transfers cannot be reversed."
  );
  if (!confirmed) return;

  const button = $("withdrawal-submit");
  const message = $("withdrawal-message");
  state.withdrawalRequestId ||= crypto.randomUUID();
  button.disabled = true;
  button.textContent = "Submitting withdrawal…";
  message.textContent = "Submitting from this business's dedicated Circle wallet…";
  message.className = "auth-message";
  try {
    const response = await apiFetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "withdraw",
        requestId: state.withdrawalRequestId,
        network: state.business?.wallet_blockchain,
        recipientAddress,
        amount,
        confirmWithdrawal: true,
        ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Withdrawal submission failed");
    if (!data.submissionUncertain) {
      state.withdrawalRequestId = null;
      $("withdrawal-recipient").value = "";
      $("withdrawal-amount").value = "";
    }
    const walletResponse = await apiFetch("/api/wallet");
    const walletData = await readJsonResponse(walletResponse);
    if (walletResponse.ok) state.wallet = walletData;
    renderAccount();
    renderBusinessPage();
    message.textContent = data.submissionUncertain
      ? "Circle did not return a definite submission result. Retry with the same details; InboxPay will reuse the same idempotency key and will not create a second withdrawal."
      : data.withdrawal?.status === "confirmed"
      ? "Withdrawal confirmed and reconciled on Arc."
      : "Withdrawal submitted. InboxPay will show the Arc receipt after confirmation.";
    toast(data.submissionUncertain ? "Withdrawal outcome needs recovery" : data.idempotent ? "Existing withdrawal restored" : "Withdrawal submitted");
  } catch (error) {
    message.textContent = error.message || "Withdrawal submission failed";
    message.className = "auth-message error";
    button.disabled = false;
    button.textContent = "Review withdrawal";
  }
}

async function loadPreflight(invoice = state.selected) {
  state.preflight = null;
  state.preflightLoading = Boolean(invoice?.invoiceNumber);
  if (!invoice?.invoiceNumber) {
    state.preflightLoading = false;
    renderDetail();
    return;
  }
  try {
    const response = await apiFetch("/api/preflight?invoice=" + encodeURIComponent(invoice.invoiceNumber));
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Payment preflight unavailable");
    if (state.selected?.invoiceNumber === invoice.invoiceNumber) {
      state.preflight = data.preflight || null;
      state.preflightLoading = false;
      const duplicatePayment = (data.preflight?.checks || []).some((check) =>
        check.key === "onchain_can_execute" && check.value === "DUPLICATE_PAYMENT"
      );
      if (duplicatePayment && !invoiceSettled(invoice)) {
        invoice.settlement = {
          ...(invoice.settlement || {}),
          status: "confirmed",
          reconciled: true,
          onchainDuplicate: true
        };
      }
      renderStats();
      renderList();
      renderDetail();
    }
  } catch (error) {
    if (state.selected?.invoiceNumber === invoice.invoiceNumber) {
      state.preflight = {
        eligible: false,
        checks: [{ key: "preflight", label: "Onchain execution preflight", ok: false, value: "Unavailable", reason: error.message || "Payment preflight unavailable" }],
        reasons: [error.message || "Payment preflight unavailable"]
      };
      state.preflightLoading = false;
      renderDetail();
    }
  }
}

function setPolicyMessage(message, isError = false) {
  const node = $("policy-message");
  node.textContent = message || "";
  node.className = "auth-message" + (isError ? " error" : "");
}

function policyAmount(value) {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number(value);
  return Number.isFinite(amount) ? String(amount) : "";
}

function renderPolicyModal() {
  const ready = policyIsReady();
  const paused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  const policy = ready && state.onchainPolicy ? state.onchainPolicy : state.policyConfig;
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const migrationNeeded = ready && state.business?.wallet_blockchain === "ARC" && state.vendorRevocationSupported === false;

  $("policy-max").value = policyAmount(policy?.max_transaction_usdc);
  $("policy-daily").value = policyAmount(policy?.daily_limit_usdc);
  $("policy-floor").value = policyAmount(policy?.cash_floor_usdc);
  const policyUnavailable = Boolean(state.policyStatusError);
  $("policy-submit").textContent = ready ? "Update onchain policy" : "Save and deploy this policy";
  $("policy-submit").disabled = policyUnavailable;

  const chainState = $("policy-chain-state");
  chainState.innerHTML = policyUnavailable
    ? '<div><strong>Live policy status unavailable</strong><span>' + escapeHtml(state.policyStatusError) + '</span></div><b class="paused">Unavailable</b>'
    : ready
      ? '<div><strong>' + (state.previewReadOnly ? "Saved policy on " : "Live on ") + network + '</strong><span>' + state.business.policy_contract_address + '</span><button class="text-action copy-address" type="button" data-address="' + state.business.policy_contract_address + '" data-label="Policy vault address">Copy address</button></div><b class="' + (paused ? "paused" : "ready") + '">' + (state.previewReadOnly ? "Saved status · not reverified" : paused ? "Payments paused" : "Enforced onchain") + '</b>'
      : '<div><strong>Not deployed yet</strong><span>Review these values before creating this business\'s policy vault.</span></div><b>Draft</b>';

  const pauseButton = $("policy-pause");
  pauseButton.hidden = !ready || policyUnavailable;
  pauseButton.dataset.paused = String(paused);
  pauseButton.textContent = paused ? "Resume payments" : "Pause all payments";
  $("policy-pause-note").textContent = ready
    ? (paused ? "No payments can execute until this business resumes them." : "Emergency control for this business's policy vault.")
    : "Emergency pause becomes available after the vault is deployed.";

  const migrationControl = $("policy-migration-control");
  migrationControl.hidden = !migrationNeeded;
  $("policy-migrate").disabled = false;
  $("policy-migrate-note").textContent = migrationNeeded
    ? "This vault cannot revoke vendors onchain. Migration deploys a replacement vault with the same limits; USDC access and vendor registrations must be authorized again."
    : "";

  const allowanceControl = $("policy-allowance-control");
  allowanceControl.hidden = !ready || policyUnavailable;
  $("policy-allowance-title").textContent = state.policyAllowance ? "USDC access authorized" : "USDC access not authorized";
  $("policy-allowance-note").textContent = state.policyAllowance
    ? "The vault can move this wallet's USDC only through the enforced policy checks."
    : "The vault cannot move funds until this business explicitly authorizes it.";
  const allowanceButton = $("policy-allowance");
  allowanceButton.dataset.authorized = String(state.policyAllowance);
  allowanceButton.textContent = state.policyAllowance ? "Revoke USDC access" : "Authorize vault";

  const autonomyEnabled = Boolean(state.policyConfig?.autonomy_enabled);
  const autonomyControl = $("policy-autonomy-control");
  autonomyControl.hidden = !ready || policyUnavailable;
  $("policy-autonomy-title").textContent = autonomyEnabled ? "Bounded autonomy enabled" : "Autonomous execution disabled";
  $("policy-autonomy-note").textContent = autonomyEnabled
    ? (state.policyConfig?.autonomy_last_error
      ? "Worker attention required: " + state.policyConfig.autonomy_last_error
      : "Eligible Gmail invoices can execute unattended inside the verified vendor, limit, cash-floor, duplicate, and pause controls.")
    : "Eligible invoices still require an individual payment action. Enabling this grants standing authority for this network only.";
  const autonomyButton = $("policy-autonomy");
  autonomyButton.dataset.enabled = String(autonomyEnabled);
  autonomyButton.textContent = autonomyEnabled ? "Disable autonomy" : "Enable bounded autonomy";
  autonomyButton.disabled = !autonomyEnabled && !state.policyAllowance;
  document.querySelectorAll("#policy-modal .copy-address").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.address, button.dataset.label));
  });
}

async function migratePolicyVault() {
  const policy = {
    max_transaction_usdc: Number($("policy-max").value),
    daily_limit_usdc: Number($("policy-daily").value),
    cash_floor_usdc: Number($("policy-floor").value)
  };
  const confirmed = window.confirm(
    "Migrate this business's policy vault on Arc Mainnet?\n\n" +
    "Current vault: " + state.business.policy_contract_address + "\n" +
    "A replacement vault will use the same limits: " + policy.max_transaction_usdc + " / " + policy.daily_limit_usdc + " / " + policy.cash_floor_usdc + " USDC.\n\n" +
    "The old vault remains deployed. USDC access and vendor registrations must be authorized again after migration. No payment will be submitted."
  );
  if (!confirmed) return;

  const button = $("policy-migrate");
  button.disabled = true;
  setPolicyMessage("Starting the replacement policy-vault deployment…");
  try {
    const response = await apiFetch("/api/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "migrate", network: state.business?.wallet_blockchain, confirmMainnet: true })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Policy-vault migration failed");
    state.business = data.business || state.business;
    toast("Replacement policy-vault deployment started");
    await loadPolicyStatus();
    renderPolicyModal();
    renderAccount();
    renderSetup();
    setPolicyMessage("Migration started. InboxPay will show the replacement vault after Arc confirms it.");
  } catch (error) {
    setPolicyMessage(error.message || "Policy-vault migration failed", true);
    button.disabled = false;
  }
}

async function openPolicyModal(options = {}) {
  setDestination("policy", options.updateUrl !== false);
  const card = $("policy-modal").querySelector(".policy-card");
  card.classList.add("is-loading");
  card.setAttribute("aria-busy", "true");
  setPolicyMessage("Loading this business's policy…");
  try {
    await Promise.all([loadPolicyConfig(), loadPolicyStatus()]);
    renderPolicyModal();
    setPolicyMessage(state.policyConfig ? "" : "Policy configuration is unavailable. Try again before deploying.", !state.policyConfig);
  } finally {
    card.classList.remove("is-loading");
    card.setAttribute("aria-busy", "false");
  }
}

function closePolicyModal() {
  setDestination("inbox");
  setPolicyMessage("");
}

function readPolicyForm() {
  const amount = (id, label) => {
    const raw = $(id).value.trim();
    if (!/^(?:\d+|\d*\.\d{1,6})$/.test(raw)) {
      throw new Error(label + " must be a non-negative USDC amount with no more than 6 decimal places");
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 1e6))) {
      throw new Error(label + " is outside the supported USDC range");
    }
    return value;
  };
  const draft = {
    max_transaction_usdc: amount("policy-max", "Maximum single payment"),
    daily_limit_usdc: amount("policy-daily", "Daily spending limit"),
    cash_floor_usdc: amount("policy-floor", "Cash floor")
  };
  if (draft.max_transaction_usdc <= 0) throw new Error("Maximum single payment must be greater than zero");
  if (draft.max_transaction_usdc > draft.daily_limit_usdc) throw new Error("Maximum single payment cannot exceed the daily limit");
  return draft;
}

function policyConfirmation(action, policy) {
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  return action + " on " + network + "?\n\n" +
    "Maximum single payment: " + policy.max_transaction_usdc + " USDC\n" +
    "Daily spending limit: " + policy.daily_limit_usdc + " USDC\n" +
    "Cash floor: " + policy.cash_floor_usdc + " USDC\n\n" +
    "Verified vendors and duplicate protection stay enforced.";
}

async function savePolicy(event) {
  event.preventDefault();
  const submit = $("policy-submit");
  try {
    const draft = readPolicyForm();
    const ready = policyIsReady();
    const mainnet = state.business?.wallet_blockchain === "ARC";
    const action = ready ? "Update this business's live payment policy" : "Deploy this business's policy vault";
    if (!window.confirm(policyConfirmation(action, draft))) return;

    submit.disabled = true;
    submit.textContent = ready ? "Updating onchain…" : "Saving policy…";
    setPolicyMessage(ready ? "Waiting for the policy transaction to complete…" : "Saving the policy before deployment…");

    const updateResponse = await apiFetch("/api/policy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        network: state.business?.wallet_blockchain,
        requireVerifiedVendor: true,
        ...(mainnet && ready ? { confirmMainnet: true } : {})
      })
    });
    const updateData = await readJsonResponse(updateResponse);
    if (!updateResponse.ok) throw new Error(updateData.error || "Policy update failed");
    state.policyConfig = updateData.policy || { ...state.policyConfig, ...draft };

    if (!ready) {
      submit.textContent = "Starting deployment…";
      setPolicyMessage("Starting the dedicated policy-vault deployment…");
      const deployResponse = await apiFetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deploy", network: state.business?.wallet_blockchain, ...(mainnet ? { confirmMainnet: true } : {}) })
      });
      const deployData = await readJsonResponse(deployResponse);
      if (!deployResponse.ok) throw new Error(deployData.error || "Policy deployment failed");
      state.business = deployData.business || state.business;
      toast("Policy vault deployment started");
    } else {
      toast("Business policy updated onchain");
    }

    await Promise.all([loadPolicyConfig(), loadPolicyStatus()]);
    renderPolicyModal();
    renderAccount();
    renderSetup();
    setPolicyMessage(ready ? "The live policy now matches these limits." : "Deployment started. InboxPay will show the vault when Arc confirms it.");
  } catch (error) {
    setPolicyMessage(error.message || "Policy update failed", true);
  } finally {
    submit.disabled = false;
    submit.textContent = policyIsReady() ? "Update onchain policy" : "Save and deploy this policy";
  }
}

async function togglePolicyPause() {
  if (!policyIsReady()) return;
  const button = $("policy-pause");
  const paused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  const nextPaused = !paused;
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const verb = nextPaused ? "Pause all payments" : "Resume payments";
  if (!window.confirm(verb + " for this business on " + network + "?\n\nThis submits an onchain policy transaction.")) return;

  button.disabled = true;
  setPolicyMessage((nextPaused ? "Pausing" : "Resuming") + " payments onchain…");
  try {
    const response = await apiFetch("/api/policy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: state.business?.wallet_blockchain, paused: nextPaused, ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {}) })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Policy pause update failed");
    state.policyConfig = data.policy || state.policyConfig;
    await loadPolicyStatus();
    renderPolicyModal();
    setPolicyMessage(nextPaused ? "All payments are paused." : "Payments are enabled again.");
  } catch (error) {
    setPolicyMessage(error.message || "Policy pause update failed", true);
  } finally {
    button.disabled = false;
  }
}

async function togglePolicyAllowance() {
  if (!policyIsReady()) return;
  const button = $("policy-allowance");
  const action = state.policyAllowance ? "revoke" : "approve";
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const message = action === "approve"
    ? "Authorize this business's policy vault to access USDC on " + network + "?\n\nThis is an unlimited token allowance. The vault contract still enforces the payment limit, daily limit, cash floor, verified-vendor registry, duplicate protection, and emergency pause."
    : "Revoke this business's policy vault access to USDC on " + network + "?\n\nAll payments will remain blocked until access is authorized again.";
  if (!window.confirm(message)) return;

  button.disabled = true;
  setPolicyMessage(action === "approve" ? "Authorizing the policy vault onchain…" : "Revoking the policy vault's USDC access…");
  try {
    const response = await apiFetch("/api/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, network: state.business?.wallet_blockchain, ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {}) })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "USDC allowance update failed");
    await loadPolicyStatus();
    renderPolicyModal();
    renderDetail();
    setPolicyMessage(action === "approve" ? "USDC access is authorized." : "USDC access has been revoked.");
  } catch (error) {
    setPolicyMessage(error.message || "USDC allowance update failed", true);
  } finally {
    button.disabled = false;
  }
}

async function togglePaymentAutonomy() {
  if (!policyIsReady()) return;
  const enabled = Boolean(state.policyConfig?.autonomy_enabled);
  const nextEnabled = !enabled;
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const policy = state.onchainPolicy || state.policyConfig || {};
  const message = nextEnabled
    ? "Enable bounded autonomous payments for this business on " + network + "?\n\n" +
      "InboxPay may pay eligible invoices from connected Gmail without an individual payment click. Every payment must still pass the verified-vendor registry, " +
      "" + policy.max_transaction_usdc + " USDC per-payment limit, " + policy.daily_limit_usdc + " USDC daily limit, " + policy.cash_floor_usdc + " USDC cash floor, duplicate protection, allowance, and emergency pause.\n\n" +
      "HOLD and ESCALATE invoices will not be paid."
    : "Disable autonomous payments for this business on " + network + "?\n\nNo new jobs will be claimed. A transaction already submitted to Arc will still be reconciled honestly.";
  if (!window.confirm(message)) return;

  const button = $("policy-autonomy");
  button.disabled = true;
  setPolicyMessage(nextEnabled ? "Enabling bounded autonomy…" : "Disabling autonomous execution…");
  try {
    const response = await apiFetch("/api/policy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: state.business?.wallet_blockchain,
        autonomyEnabled: nextEnabled,
        confirmAutonomy: nextEnabled,
        ...(nextEnabled && state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Autonomy update failed");
    state.policyConfig = data.policy || state.policyConfig;
    renderPolicyModal();
    setPolicyMessage(nextEnabled
      ? "Bounded autonomy is enabled for this business and network."
      : "Autonomous execution is disabled. Manual settlement remains available.");
    toast(nextEnabled ? "Bounded autonomy enabled" : "Autonomous execution disabled");
  } catch (error) {
    setPolicyMessage(error.message || "Autonomy update failed", true);
  } finally {
    button.disabled = false;
  }
}


function renderStats() {
  renderPaymentFlow();
  const settled = state.invoices.filter(invoiceSettled);
  const payable = state.invoices.filter(invoicePaymentReady);
  const held = state.invoices.filter((x) => !invoiceSettled(x) && (
    x.agentDecision !== "PAY_NOW" ||
    ["processing", "failed", "review"].includes(x.settlement?.status)
  ));
  const total = payable.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  $("invoice-count").textContent = state.invoices.length;
  $("payment-count").textContent = settled.length;
  $("queue-count").textContent = state.invoices.length + (state.invoices.length === 1 ? " invoice" : " invoices");
  const metrics = [
    ["◎", "Ready for payment", total.toFixed(2) + " USDC", payable.length + " invoices · final checks on open"],
    ["◷", "Needs you", String(held.length), "invoices awaiting review"],
    ["✓", "Paid", String(settled.length), "confirmed & reconciled"],
    ["⌁", "Scheduled", String(state.invoices.filter((invoice) => !invoiceSettled(invoice) && (invoice.settlement?.status === "scheduled" || invoice.agentDecision === "SCHEDULE")).length), "queued or due later"]
  ];
  if (state.inboxStatus === "error") {
    metrics.forEach((metric) => { metric[2] = "—"; metric[3] = "Inbox unavailable · refresh to update"; });
    $("queue-count").textContent = "Unavailable";
    $("invoice-count").textContent = "—";
    $("payment-count").textContent = "—";
  }
  $("stats").innerHTML = metrics.map(([icon, label, value, meta]) =>
    '<div class="stat"><div class="stat-icon">' + icon + '</div><div><span>' + label +
    '</span><strong>' + value + '</strong><small>' + meta + '</small></div></div>'
  ).join("");
  renderQueueControls();
}

function queueCategory(invoice) {
  return invoiceQueueCategory(invoice, invoicePaymentReady(invoice));
}

function visibleQueueInvoices() {
  const filter = state.queue.filter || "all";
  const query = (state.queue.query || "").trim().toLowerCase();
  return state.invoices.filter((invoice) => {
    const filterMatch = filter === "all" || queueCategory(invoice) === filter;
    if (!filterMatch || !query) return filterMatch;
    return [invoice.vendor, invoice.invoiceNumber, invoice.dueDate, invoice.currency, invoice.agentDecision]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderQueueControls() {
  const node = $("queue-filters");
  if (!node) return;
  const counts = state.invoices.reduce((summary, invoice) => {
    summary[queueCategory(invoice)] += 1;
    return summary;
  }, { ready: 0, review: 0, settled: 0 });
  const filters = [
    ["all", "All", state.invoices.length],
    ["ready", "Ready", counts.ready],
    ["review", "Review", counts.review],
    ["settled", "Settled", counts.settled]
  ];
  node.innerHTML = filters.map(([value, label, count]) =>
    '<button type="button" class="filter-button' + (state.queue.filter === value ? " active" : "") + '" data-queue-filter="' + value + '" aria-pressed="' + (state.queue.filter === value) + '"><span>' + label + '</span><b>' + count + '</b></button>'
  ).join("");
  $("queue-search").value = state.queue.query || "";
}

function renderList() {
  renderQueueControls();
  if (!state.invoices.length) {
    $("invoice-list").innerHTML = '<div class="queue-list"><div class="empty queue-empty"><div class="empty-icon">✉</div><h3>No invoices found</h3><p>' + (state.previewReadOnly ? "No saved invoices are available for this business. This preview does not scan Gmail." : "The live Gmail evaluation returned no invoice records for this business.") + '</p></div></div>';
    return;
  }
  const visibleInvoices = visibleQueueInvoices();
  if (!visibleInvoices.length) {
    $("invoice-list").innerHTML = '<div class="queue-list"><div class="empty queue-empty compact"><div class="empty-icon">⌕</div><h3>No matching invoices</h3><p>Change the queue filter or search term to see more records.</p><button id="clear-queue-view" class="ghost" type="button">Clear filters</button></div></div>';
    $("clear-queue-view").addEventListener("click", () => {
      state.queue = { filter: "all", query: "" };
      renderList();
    });
    return;
  }
  $("invoice-list").innerHTML = '<div class="queue-list">' + visibleInvoices.map((invoice) => {
    const selected = state.selected?.invoiceNumber === invoice.invoiceNumber ? " selected" : "";
    const displayDecision = state.preflightLoading && selected
      ? "CHECKING"
      : invoiceSettled(invoice)
      ? "SETTLED"
      : invoice.settlement?.status === "processing"
        ? "PROCESSING"
        : invoice.settlement?.status === "scheduled"
          ? "SCHEDULED"
        : invoice.settlement?.status === "failed"
          ? "FAILED"
          : invoice.settlement?.status === "review"
            ? "REVIEW"
            : invoice.agentDecision;
    return '<button class="invoice-row' + selected + '" type="button" aria-current="' + (selected ? "true" : "false") + '" data-category="' + queueCategory(invoice) + '" data-invoice="' +
      encodeURIComponent(invoice.invoiceNumber) + '"><div class="avatar">' +
      escapeHtml((invoice.vendor || "V").slice(0, 1)) + '</div><div class="main"><div class="row-title"><strong>' +
      escapeHtml(invoice.vendor || "Unknown vendor") + '</strong>' + status(displayDecision) + '</div><span class="sub">' +
      escapeHtml(invoice.invoiceNumber || "Missing invoice number") + ' · due ' + escapeHtml(invoice.dueDate || "not found") +
      '</span></div><div class="amount">' + Number(invoice.amount || 0).toFixed(2) + ' ' +
      escapeHtml(invoice.currency || "") + '</div><span class="chev">›</span></button>';
  }).join("") + '</div>';

  document.querySelectorAll(".invoice-row").forEach((button) => {
    button.addEventListener("click", () => {
      const number = decodeURIComponent(button.dataset.invoice);
      state.selected = state.invoices.find((x) => x.invoiceNumber === number);
      state.preflight = null;
      state.preflightLoading = true;
      renderList();
      renderDetail();
      invoiceDrawer.open(button);
      loadPreflight(state.selected);
    });
  });
}

function renderDetail() {
  const invoice = state.selected;
  renderPaymentFlow();
  if (!invoice) return;
  const processing = invoice.settlement?.status === "processing";
  const reviewRequired = invoice.settlement?.status === "review";
  const scheduled = invoice.settlement?.status === "scheduled";
  const dueReview = reviewRequired && invoice.schedule?.status === "queued";
  const preflight = state.preflight?.invoiceNumber === invoice.invoiceNumber ? state.preflight : null;
  const checking = state.preflightLoading;
  const settled = !checking && (invoiceSettled(invoice) || preflightSettled(preflight));
  const scheduleDecision = invoice.agentDecision === "SCHEDULE" && !settled && !processing && !reviewRequired && !scheduled;
  const autonomyEnabled = Boolean(state.policyConfig?.autonomy_enabled);
  const autonomy = invoice.autonomy;
  const decisionReady = invoice.agentDecision === "PAY_NOW" && !settled;
  const vaultReady = policyIsReady();
  const policyPaused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  const vendor = state.vendors.find((item) => item.name === invoice.vendor);
  const vendorReady = vendor?.status === "verified" &&
    vendor?.onchain_status === "registered" &&
    (vendor?.invoice_sender_emails || []).length > 0;
  const ready = !state.previewReadOnly && Boolean(preflight?.eligible);
  const detailStatus = checking
    ? "CHECKING"
    : settled
      ? "SETTLED"
      : processing
      ? "PROCESSING"
      : invoice.settlement?.status === "scheduled"
        ? "SCHEDULED"
      : invoice.settlement?.status === "failed"
        ? "FAILED"
        : reviewRequired
          ? "REVIEW"
          : invoice.agentDecision;
  const settlementNetwork = state.business?.wallet_blockchain === "ARC-TESTNET"
    ? "Arc Testnet"
    : state.business?.wallet_blockchain === "ARC"
      ? "Arc Mainnet"
      : "Arc";
  const vendorInitial = (invoice.vendor || "V").slice(0, 1);
  const reasons = checking
    ? ["Checking the current settlement state before showing payment actions."]
    : settled
      ? ["Payment executed and reconciled on " + settlementNetwork + "."]
      : (invoice.decisionReasons?.length ? invoice.decisionReasons : ["No decision reason recorded."]);
  const reasonsHtml = '<ul>' + reasons.map((reason) => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul>';
  const gateReasons = state.previewReadOnly ? ["Payments are disabled in this QA preview.", ...(preflight?.reasons || [])] : preflight?.reasons || ["Checking the live policy vault and payment state…"];
  const gateHtml = '<div class="preflight"><div class="decision-head">● Payment readiness</div><ul>' + gateReasons.map((reason) => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul></div>';
  const checksHtml = preflight
    ? preflight.checks.map(checkRowState).join("")
    : checkRow("Required fields", invoice.invoiceNumber && invoice.amount !== null && invoice.dueDate ? "Complete" : "Review") +
      checkRow("Currency rail", invoice.currency || "Unknown") +
      checkRow("Vendor registry", vendorReady || settled ? "Verified" : "Onchain registration required") +
      checkRow("Business wallet", state.business?.wallet_status === "ready" ? "Ready" : "Provisioning") +
      checkRow("Policy vault", vaultReady ? "Ready" : "Not ready") +
      checkRow("USDC authorization", state.policyAllowance ? "Ready" : "Required") +
      checkRow("Emergency pause", policyPaused ? "Paused" : "Ready");
  const autonomyHtml = autonomy
    ? '<div class="schedule-card"><div><strong>Autonomous execution · ' + escapeHtml(autonomy.status) + '</strong><span>' +
      escapeHtml(autonomy.scheduled_for ? new Date(autonomy.scheduled_for).toLocaleString() : "Execution time pending") +
      '</span><small>' + escapeHtml(autonomy.last_error || (autonomy.status === "completed" ? "Execution completed. See the payment record for its reconciliation details." : autonomy.status === "reconciling" ? "Payment submitted; awaiting confirmed Arc reconciliation." : "The worker will recheck the latest business and onchain policy before any payment.")) + '</small></div></div>'
    : autonomyEnabled && scheduleDecision
      ? '<div class="schedule-card"><div><strong>Bounded autonomy active</strong><span>This invoice will be queued for its due date by the background operator.</span><small>Execution still requires PAY_NOW at that time plus every live vendor, allowance, limit, cash-floor, duplicate, pause, and reconciliation check.</small></div></div>'
      : "";
  const scheduleHtml = autonomyHtml || (scheduled
    ? '<div class="schedule-card"><div><strong>Queued for review</strong><span>' +
      escapeHtml(invoice.schedule?.scheduledFor ? new Date(invoice.schedule.scheduledFor).toLocaleString() : "Target pending audit reconciliation") +
      '</span><small>Vendor verification and live policy preflight are still required. No payment has been submitted.</small></div><div class="schedule-actions"><button id="reschedule-button" class="ghost" type="button">Reschedule</button><button id="cancel-schedule" class="ghost" type="button">Cancel schedule</button></div></div>'
    : dueReview
      ? '<div class="schedule-card"><div><strong>Due for review</strong><span>' +
        escapeHtml(invoice.schedule?.scheduledFor ? new Date(invoice.schedule.scheduledFor).toLocaleString() : "Target reached") +
        '</span><small>The queue has paused this invoice for owner review. Releasing it changes no funds; vendor verification and live policy preflight still gate payment.</small></div><button id="cancel-schedule" class="ghost" type="button">Release to review</button></div>'
    : scheduleDecision
      ? '<div class="schedule-card"><div><strong>Schedule this invoice</strong><span>Queue for review on the due date</span><small>This records a durable review queue entry only. It will not move funds or bypass vendor verification.</small></div><button id="schedule-button" class="ghost" type="button">Queue for due date</button></div>'
      : "");
  $("detail").innerHTML = '<div class="detail-inner"><div class="detail-top"><div><label>INVOICE</label><h2>' +
    escapeHtml(invoice.invoiceNumber || "Needs review") + '</h2></div>' + status(detailStatus) + '</div>' +
    '<div class="merchant"><div class="avatar big">' + escapeHtml(vendorInitial) + '</div><div><strong>' +
    escapeHtml(invoice.vendor || "Unknown vendor") + '</strong><span>' + escapeHtml(invoice.currency || "Unknown") +
    ' settlement · due ' + escapeHtml(invoice.dueDate || "not found") + '</span></div></div><div class="big-amount">' +
    Number(invoice.amount || 0).toFixed(2) + ' <span>' + escapeHtml(invoice.currency || "") + '</span></div><div class="decision"><div class="decision-head">● Agent reasoning</div>' +
    reasonsHtml + '<div class="confidence"><span>Extraction confidence</span><b>' +
    escapeHtml(invoice.extraction?.confidence || "unknown") + '</b></div><div class="confidence"><span>Invoice evidence</span><b>' +
    Number(invoice.sourceCount || invoice.sources?.length || 0) + " source" + (Number(invoice.sourceCount || invoice.sources?.length || 0) === 1 ? "" : "s") + '</b></div></div>' +
    scheduleHtml + '<details class="payment-details"' + (ready || settled ? '' : ' open') + '><summary>Payment checks <span>' + (checking ? 'Checking…' : ready ? 'Ready' : settled ? 'Complete' : 'Needs attention') + '</span></summary>' + gateHtml + '<div class="checks">' + checksHtml +
    (processing ? checkRow("Payment recovery", "In progress") : reviewRequired ? checkRow("Payment recovery", "Manual review") : "") +
    '</div></details>' + (settled ? '<div class="settlement" id="settlement-receipt"><span>Payment receipt</span><b>Confirmed</b><small>Open Payments to view the transaction hash and reconciliation record.</small><button id="receipt-open-payments" class="ghost" type="button">View payment record ↗</button></div>' : "") +
    '<button id="pay-button" class="pay"' + (ready ? "" : " disabled") +
    '>' + (ready ? (invoice.settlement?.status === "failed" ? "Review & retry on Arc ↗" : "Review & settle on Arc ↗") : checking ? "Checking settlement state…" : settled ? "Settled on Arc ✓" : processing ? "Payment submitted · recovering…" : scheduled ? "Queued for review" : reviewRequired ? "Payment under review" : scheduleDecision ? "Schedule this invoice above" : preflight ? "Payment blocked" : "Checking payment gates…") + '</button></div>';

  if (settled) { const receiptButton = $("receipt-open-payments"); if (receiptButton) receiptButton.addEventListener("click", () => openActivity("payments")); }
  if (ready) $("pay-button").addEventListener("click", settle);
  if (scheduleDecision && !autonomyEnabled) $("schedule-button").addEventListener("click", scheduleInvoice);
  if (scheduled) $("reschedule-button").addEventListener("click", rescheduleScheduledInvoice);
  if (scheduled || dueReview) {
    $("cancel-schedule").addEventListener("click", cancelScheduledInvoice);
  }
}

function checkRow(label, value) {
  const ok = value === "Complete" || value === "USDC" || value === "Verified" || value === "Ready";
  return '<div class="check-row"><span class="' + (ok ? "check-ok" : "") + '">' + (ok ? "✓" : "○") + " " + escapeHtml(label) +
    '</span><b>' + escapeHtml(value) + '</b></div>';
}

function checkRowState(check) {
  return '<div class="check-row"><span class="' + (check.ok ? "check-ok" : "") + '">' + (check.ok ? "✓" : "○") + " " + escapeHtml(check.label) +
    '</span><b title="' + escapeHtml(check.reason || "") + '">' + escapeHtml(check.value || (check.ok ? "Ready" : "Blocked")) + '</b></div>';
}

function closeActivityModal() {
  setDestination("inbox");
  $("activity-message").textContent = "";
}

function formatActivityDate(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function activityFilters(kind) {
  return kind === "payments"
    ? [["all", "All"], ["confirmed", "Settled"], ["processing", "Processing"], ["attention", "Needs attention"]]
    : [["all", "All"], ["payments", "Payments"], ["policy", "Policy"], ["vendors", "Vendors"], ["business", "Business"]];
}

function activityMatches(kind, row) {
  const filter = state.activity.filter || "all";
  const query = (state.activity.query || "").trim().toLowerCase();
  const status = String(row.status || "").toLowerCase();
  const category = auditEventCategory(row.event_type);
  const filterMatch = filter === "all" || (kind === "payments"
    ? (filter === "attention" ? ["failed", "review"].includes(status) : status === filter)
    : category === filter);
  if (!filterMatch) return false;
  if (!query) return true;
  return JSON.stringify(row).toLowerCase().includes(query) ||
    (kind === "audit" && auditEventLabel(row.event_type).toLowerCase().includes(query));
}

function renderActivitySummary(kind, rows) {
  const node = $("activity-summary");
  if (kind === "payments") {
    const confirmed = rows.filter((row) => String(row.status).toLowerCase() === "confirmed");
    const confirmedUsdc = confirmed.filter((row) => row.currency === "USDC").reduce((total, row) => total + Number(row.amount || 0), 0);
    const attention = rows.filter((row) => ["failed", "review"].includes(String(row.status).toLowerCase())).length;
    node.innerHTML = [
      pageMetric("Settlement records", String(rows.length), "All attempts for this business"),
      pageMetric("Confirmed", String(confirmed.length), confirmedUsdc.toFixed(2) + " USDC reconciled", "ready"),
      pageMetric("Needs attention", String(attention), attention ? "Review failed or flagged attempts" : "No failed attempts", attention ? "attention" : "ready")
    ].join("");
    return;
  }
  const categories = new Set(rows.map((row) => auditEventCategory(row.event_type)));
  node.innerHTML = [
    pageMetric("Audit records", String(rows.length), "Immutable business-scoped events"),
    pageMetric("Control areas", String(categories.size), "Payments, policy, vendors and profile"),
    pageMetric("Latest activity", rows[0] ? formatActivityDate(rows[0].created_at) : "None", "Most recent recorded decision", "ready")
  ].join("");
}

function renderActivityControls(kind) {
  const toolbar = $("activity-toolbar");
  const search = document.querySelector('.activity-search[for="activity-search"]');
  toolbar.hidden = false;
  search.hidden = false;
  $("activity-filters").innerHTML = activityFilters(kind).map(([value, label]) =>
    '<button type="button" class="filter-button' + (state.activity.filter === value ? " active" : "") + '" data-filter="' + value + '" aria-pressed="' + (state.activity.filter === value) + '">' + label + '</button>'
  ).join("");
  $("activity-search").value = state.activity.query || "";
}

function renderActivity(kind, rows) {
  const node = $("activity-list");
  renderActivitySummary(kind, rows);
  renderActivityControls(kind);
  const visibleRows = rows.filter((row) => activityMatches(kind, row));
  if (!visibleRows.length) {
    const hasRecords = rows.length > 0;
    node.innerHTML = '<div class="activity-empty"><strong>' + (hasRecords ? "No matching records" : "Nothing recorded yet") + '</strong><span>' +
      (hasRecords ? "Change the filter or search term to see more activity." : (kind === "payments" ? "Payment attempts will appear here with their Arc settlement status and receipts." : "Business policy, vendor, wallet, and settlement decisions will appear here.")) + '</span></div>';
    return;
  }
  if (kind === "payments") {
    node.innerHTML = visibleRows.map((payment) => {
      const statusValue = String(payment.status || "unknown").toLowerCase();
      const explorer = payment.network === "ARC" ? "https://arcscan.app/tx/" : "https://testnet.arcscan.app/tx/";
      return '<article class="payment-record"><div class="record-status-mark ' + escapeHtml(statusValue) + '"></div><div class="record-primary"><span>' + escapeHtml(payment.vendor || "Unknown vendor") + '</span><strong>' + escapeHtml(payment.invoiceNumber || "Missing invoice number") + '</strong><small>' + escapeHtml(formatActivityDate(payment.updatedAt)) + '</small></div><div class="record-network"><span>' + escapeHtml(payment.network === "ARC" ? "Arc Mainnet" : "Arc Testnet") + '</span><b class="activity-status ' + escapeHtml(statusValue) + '">' + escapeHtml(statusValue) + '</b></div><div class="record-amount"><strong>' + Number(payment.amount || 0).toFixed(2) + '</strong><span>' + escapeHtml(payment.currency || "") + '</span></div><div class="record-receipt">' +
        (payment.paymentId ? '<span title="' + escapeHtml(payment.paymentId) + '">ID ' + escapeHtml(payment.paymentId.slice(0, 10) + "…") + '</span>' : '<span>No payment ID</span>') +
        (payment.paymentTxHash ? '<a href="' + explorer + encodeURIComponent(payment.paymentTxHash) + '" target="_blank" rel="noreferrer">View Arc receipt ↗</a>' : '<span>Receipt pending</span>') + '</div></article>';
    }).join("");
    return;
  }
  node.innerHTML = visibleRows.map((event) => {
    const category = auditEventCategory(event.event_type);
    return '<article class="audit-record"><div class="audit-marker ' + category + '"></div><div class="audit-record-body"><div class="audit-record-meta"><span class="audit-category">' + escapeHtml(category) + '</span><time>' + escapeHtml(formatActivityDate(event.created_at)) + '</time></div><h3>' + escapeHtml(auditEventLabel(event.event_type)) + '</h3><p>' + escapeHtml(event.actor || "system") + ' recorded a ' + (event.invoice_id ? "invoice-level" : "business-level") + ' control event.</p><details><summary>Technical details</summary><pre>' + escapeHtml(JSON.stringify(event.data || {}, null, 2)) + '</pre></details></div></article>';
  }).join("");
}

function renderActivityLoading(kind) {
  $("activity-summary").innerHTML = Array.from({ length: 3 }, () =>
    '<article class="page-metric skeleton-metric" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line value"></span><span class="skeleton-line"></span></article>'
  ).join("");
  renderActivityControls(kind);
  $("activity-list").innerHTML = Array.from({ length: 3 }, () =>
    '<div class="skeleton-record" aria-hidden="true"><span class="skeleton-status"></span><div><span class="skeleton-line medium"></span><span class="skeleton-line"></span></div><span class="skeleton-line short"></span></div>'
  ).join("");
}

async function openActivity(kind, options = {}) {
  setDestination(kind, options.updateUrl !== false);
  const requestId = ++activityRequestId;
  $("activity-kicker").textContent = kind === "payments" ? "SETTLEMENTS" : "AUDIT TRAIL";
  $("activity-title").textContent = kind === "payments" ? "Payments" : "Audit trail";
  $("activity-context").textContent = kind === "payments"
    ? "Every submitted, failed, processing, or reconciled payment for this business."
    : "Business-scoped evidence for policy, vendor, wallet, and settlement decisions.";
  $("activity-message").textContent = "Loading live activity…";
  $("activity-message").className = "auth-message loading-message";
  state.activity = { kind, rows: [], data: null, filter: "all", query: "" };
  $("activity-list").setAttribute("aria-busy", "true");
  renderActivityLoading(kind);
  try {
    const response = await apiFetch("/api/activity?view=" + encodeURIComponent(kind));
    const data = await readJsonResponse(response);
    if (requestId !== activityRequestId || activeDestination !== kind) return;
    if (!response.ok) throw new Error(data.error || "Activity unavailable");
    const rows = kind === "payments" ? (data.payments || []) : kind === "audit" ? (data.events || []) : [];
    state.activity = { kind, rows, data: null, filter: "all", query: "" };
    $("activity-message").textContent = "";
    $("activity-message").className = "auth-message";
    $("activity-list").setAttribute("aria-busy", "false");
    renderActivity(kind, state.activity.rows, state.activity.data);
  } catch (error) {
    if (requestId !== activityRequestId || activeDestination !== kind) return;
    $("activity-list").setAttribute("aria-busy", "false");
    $("activity-list").innerHTML = '<div class="activity-empty"><strong>Activity could not load</strong><span>Return to invoices or try this destination again.</span></div>';
    $("activity-message").textContent = error.message || "Activity unavailable";
    $("activity-message").className = "auth-message error";
  }
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => $("toast").hidden = true, 3200);
}

async function openVendorModal(options = {}) {
  setDestination("vendors", options.updateUrl !== false);
  $("vendor-name").focus();
  await loadVendors();
}

async function loadVendors() {
  try {
    const response = await apiFetch("/api/vendors");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to load vendors");
    state.vendors = data.vendors || [];
    state.vendorsError = null;
    state.vendorRevocationSupported = data.vendorRevocationSupported ?? null;
    renderVendors();
  } catch (error) {
    state.vendorsError = error.message;
    renderVendors();
    $("vendor-message").textContent = "Vendor records could not be loaded. Reopen Vendors to retry; no registry changes were made.";
    $("vendor-message").className = "auth-message error";
  }
}

function renderVendors() {
  const node = $("vendor-list");
  if (state.vendorsError) {
    $("vendor-summary").innerHTML = pageMetric("Vendor records", "Unavailable", "Load failed; this is not an empty registry", "attention");
    $("vendor-count-label").textContent = "Unavailable";
    node.innerHTML = '<div class="vendor-empty"><strong>Vendor records unavailable</strong><span>Reopen Vendors to retry. Your saved recipients have not changed.</span></div>';
    return;
  }
  $("vendor-message").textContent = "";
  const paymentReady = state.vendors.filter((vendor) =>
    vendor.status === "verified" &&
    vendor.onchain_status === "registered" &&
    (vendor.invoice_sender_emails || []).length
  ).length;
  const blocked = state.vendors.filter((vendor) => vendor.status === "blocked").length;
  $("vendor-summary").innerHTML = [
    pageMetric("Total vendors", String(state.vendors.length), "Saved in this business's active network"),
    pageMetric("Payment ready", String(paymentReady), "Verified and registered onchain", "ready"),
    pageMetric("Blocked", String(blocked), blocked ? "Cannot receive payments" : "No revoked recipients", blocked ? "attention" : "ready")
  ].join("");
  $("vendor-count-label").textContent = state.vendors.length + (state.vendors.length === 1 ? " vendor" : " vendors");
  if (state.vendorRevocationSupported === false) {
    $("vendor-message").textContent = "This vault version cannot revoke vendor addresses onchain. InboxPay can block a vendor in its registry; full chain revocation needs a vault migration.";
    $("vendor-message").className = "auth-message error";
  }
  if (!state.vendors.length) {
    node.innerHTML = '<div class="vendor-empty"><strong>No vendors registered</strong><span>Add a verified recipient on the left. It will remain blocked from payment until you explicitly verify it.</span></div>';
    return;
  }
  node.innerHTML = state.vendors.map((vendor) => {
    const registryStatus = vendor.status || "review";
    const chainStatus = vendor.onchain_status || "unavailable";
    const recipientMatch = registryStatus === "verified" && chainStatus === "registered";
    const senderEmails = vendor.invoice_sender_emails || [];
    const chainLabel = chainStatus === "registered" ? "Registered" : chainStatus === "missing" ? "Missing" : chainStatus === "unavailable" ? "Unavailable" : "Not checked";
    return '<div class="vendor-row"><div><strong>' + escapeHtml(vendor.name) + '</strong><span>' +
    escapeHtml(vendor.recipient_address) +
    '</span><button class="text-action copy-address" type="button" data-address="' + escapeHtml(vendor.recipient_address) + '" data-label="Vendor address">Copy address</button>' +
    '<form class="vendor-sender-form" data-id="' + escapeHtml(vendor.id) + '"><label>Verified invoice senders</label><div><input type="text" value="' + escapeHtml(senderEmails.join(", ")) + '" placeholder="billing@vendor.com" aria-label="Verified invoice sender emails for ' + escapeHtml(vendor.name) + '"><button class="ghost" type="submit">Save senders</button></div><small>Comma-separated, up to five. Unmatched Gmail invoices stay in review.</small></form>' +
    '</div><div class="vendor-state"><span class="vendor-state-line"><b>Registry</b> ' + escapeHtml(registryStatus) + '</span><span class="vendor-state-line"><b>Onchain</b> ' + escapeHtml(chainLabel) + '</span><span class="vendor-state-line"><b>Sender identity</b> ' + (senderEmails.length ? escapeHtml(senderEmails.length + " verified") : "missing") + '</span><span class="vendor-state-line"><b>Recipient</b> ' + (recipientMatch ? "matches registry" : "does not match / unavailable") + '</span><b class="vendor-status ' + (recipientMatch && senderEmails.length ? "verified" : "review") + '">' +
    (recipientMatch && senderEmails.length ? "payment ready" : "payment blocked") + '</b>' +
    (registryStatus === "review" || chainStatus === "missing"
      ? '<button class="ghost verify-vendor" data-id="' + escapeHtml(vendor.id) + '">' + (chainStatus === "missing" ? "Register onchain" : "Verify") + '</button>'
      : "") +
    (registryStatus === "verified" || chainStatus === "registered"
      ? '<button class="ghost revoke-vendor" data-id="' + escapeHtml(vendor.id) + '">Revoke vendor</button>'
      : "") +
    '</div></div>';
  }).join("");

  document.querySelectorAll(".verify-vendor").forEach((button) => {
    button.addEventListener("click", () => verifyVendor(button.dataset.id));
  });
  document.querySelectorAll(".revoke-vendor").forEach((button) => {
    button.addEventListener("click", () => revokeVendor(button.dataset.id));
  });
  document.querySelectorAll("#vendor-list .copy-address").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.address, button.dataset.label));
  });
  document.querySelectorAll("#vendor-list .vendor-sender-form").forEach((form) => {
    form.addEventListener("submit", updateVendorSenders);
  });
}

async function updateVendorSenders(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const vendor = state.vendors.find((item) => item.id === form.dataset.id);
  if (!vendor) return;
  const senderEmails = form.querySelector("input").value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  if (!window.confirm(
    "Update verified invoice senders for " + vendor.name + "?\n\n" +
    (senderEmails.join("\n") || "No sender emails") + "\n\nNetwork: " + network +
    "\n\nInvoices from other senders will stay in review."
  )) return;
  const submit = form.querySelector("button");
  submit.disabled = true;
  try {
    const response = await apiFetch("/api/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: vendor.id,
        action: "update_sender_emails",
        senderEmails,
        network: state.business?.wallet_blockchain,
        ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to update invoice senders");
    $("vendor-message").textContent = "Verified invoice senders updated. Refreshing the invoice review queue…";
    $("vendor-message").className = "auth-message";
    await loadVendors();
    await load();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  } finally {
    submit.disabled = false;
  }
}

async function verifyVendor(id) {
  try {
    const vendor = state.vendors.find((item) => item.id === id);
    if (!vendor) throw new Error("Vendor not found");
    const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
    const onchain = policyIsReady();
    const prompt = "Verify " + vendor.name + " for payments?\n\nRecipient: " + vendor.recipient_address +
      "\nInvoice senders: " + ((vendor.invoice_sender_emails || []).join(", ") || "none configured") +
      "\nNetwork: " + network + (onchain ? "\n\nThis updates the business's onchain vendor registry." : "\n\nThis saves the verification. After the vault is deployed, InboxPay will require a separate onchain registration before payment.");
    if (!window.confirm(prompt)) return;
    const response = await apiFetch("/api/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        network: state.business?.wallet_blockchain,
        status: "verified",
        ...(state.business?.wallet_blockchain === "ARC" && onchain ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
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

async function revokeVendor(id) {
  try {
    const vendor = state.vendors.find((item) => item.id === id);
    if (!vendor) throw new Error("Vendor not found");
    const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
    if (!window.confirm(
      "Revoke " + vendor.name + " from payments?\n\nRecipient: " + vendor.recipient_address +
      "\nNetwork: " + network + "\n\nThis clears the vendor mapping on the policy vault and blocks the vendor in InboxPay."
    )) return;
    const response = await apiFetch("/api/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        network: state.business?.wallet_blockchain,
        status: "blocked",
        ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to revoke vendor");
    $("vendor-message").textContent = data.warning || "Vendor revoked onchain and blocked in InboxPay.";
    $("vendor-message").className = "auth-message";
    await loadVendors();
    await load();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  }
}

function closeVendorModal() {
  setDestination("inbox");
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
        recipientAddress: $("vendor-address").value.trim(),
        senderEmails: [$("vendor-email").value.trim().toLowerCase()],
        network: state.business?.wallet_blockchain
      })
    });
    const data = await readJsonResponse(response);
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

async function startGmailConnection() {
  const buttons = [$('connect-gmail'), $('empty-connect'), $('empty-reconnect')].filter(Boolean);
  const labels = buttons.map((button) => button.textContent);
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Opening Google…";
  });

  try {
    const response = await apiFetch("/api/gmail/start");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to start Gmail connection");
    window.location.href = data.url;
  } catch (error) {
    buttons.forEach((button, index) => {
      button.disabled = false;
      button.textContent = labels[index];
    });
    toast(error.message);
  }
}

const connectGmail = singleFlight(startGmailConnection);

function renderInboxLoading() {
  $("queue-count").textContent = "Syncing…";
  $("stats").innerHTML = Array.from({ length: 4 }, () =>
    '<div class="stat skeleton-stat" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line value"></span><span class="skeleton-line"></span></div>'
  ).join("");
  $("invoice-list").innerHTML = '<div class="queue-list skeleton-list" aria-hidden="true">' + Array.from({ length: 4 }, () =>
    '<div class="skeleton-invoice"><span class="skeleton-avatar"></span><div><span class="skeleton-line medium"></span><span class="skeleton-line"></span></div><span class="skeleton-line amount"></span></div>'
  ).join("") + '</div>';
  $("detail").innerHTML = '<div class="detail-inner detail-skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line title"></span><div class="skeleton-merchant"></div><span class="skeleton-line amount"></span><div class="skeleton-block"></div><div class="skeleton-block tall"></div></div>';
}

function setInboxBusy(busy) {
  const refresh = $("refresh");
  refresh.disabled = busy;
  refresh.textContent = busy ? "Refreshing…" : "Refresh inbox";
  $("stats").setAttribute("aria-busy", String(busy));
  $("invoice-list").setAttribute("aria-busy", String(busy));
  document.body.classList.toggle("inbox-syncing", busy);
}

async function load() {
  if (state.businessNameRequired) { renderSetup(); return; }
  if (!state.previewReadOnly && (!state.gmail?.status || state.gmail.status !== "connected")) {
    state.inboxStatus = "disconnected";
    setInboxBusy(false);
    state.invoices = [];
    state.selected = null;
    state.preflight = null;
    state.preflightLoading = false;
    renderStats();
    renderList();
    invoiceDrawer.close();
    $("invoice-list").innerHTML = '<div class="empty"><div class="empty-icon">✉</div><h3>Your invoices start here.</h3><p>Connect the Gmail inbox where your business receives invoices. Your agent will find the invoices and bring them here for review.</p><button id="empty-connect" class="primary-button" type="button">Connect Gmail ↗</button><a href="/help.html#connect">What happens when I connect?</a></div>';
    $("empty-connect").addEventListener("click", connectGmail);
    return;
  }

  setInboxBusy(true);
  if (!state.invoices.length) renderInboxLoading();
  try {
    const response = await apiFetch("/api/invoices");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Invoice data unavailable");
    state.invoices = data.invoices || [];
    state.inboxStatus = "ready";
    state.liveGmail = data.liveGmail === true;
    state.evaluatedAt = data.evaluatedAt || null;
    const evaluatedLabel = state.evaluatedAt
      ? new Date(state.evaluatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "time unavailable";
    $("feed-state").dataset.state = state.previewReadOnly ? "preview" : state.liveGmail ? "connected" : "warning";
    $("feed-label").textContent = state.previewReadOnly ? "Saved Gmail records" : state.liveGmail ? "Live Gmail evaluated" : "Live Gmail read unavailable";
    $("feed-meta").textContent = state.previewReadOnly ? state.invoices.length + " saved invoices · no new inbox scan" : state.liveGmail
      ? state.invoices.length + " invoice" + (state.invoices.length === 1 ? "" : "s") + " · evaluated " + evaluatedLabel
      : "Inbox is connected, but this evaluation did not include a live Gmail read.";
    state.selected = state.selected
      ? state.invoices.find((x) => x.invoiceNumber === state.selected.invoiceNumber) || null
      : null;
    if (!state.selected) invoiceDrawer.close();
    state.preflight = null;
    state.preflightLoading = Boolean(state.selected);
    renderStats();
    renderList();
    renderDetail();
    await loadPreflight(state.selected);
  } catch (error) {
    state.inboxStatus = "error";
    state.invoices = [];
    state.selected = null;
    state.preflight = null;
    state.preflightLoading = false;
    const failure = inboxFailurePresentation(error.message || "");
    const authRevoked = failure.kind === "reauthorization";
    if (authRevoked) {
      state.gmail = { ...(state.gmail || {}), status: "reauthorization_required" };
      $("connect-gmail").textContent = "Reconnect Gmail";
      $("connect-gmail").disabled = false;
      $("connect-gmail").hidden = false;
      $("feed-dot").textContent = "○";
    }
    $("feed-label").textContent = failure.feedLabel;
    $("feed-meta").textContent = failure.feedMeta;
    $("feed-state").dataset.state = authRevoked ? "reauthorization" : "error";
    renderStats();
    renderList();
    const action = authRevoked
      ? '<button id="empty-reconnect" class="pay">' + failure.actionLabel + '</button>'
      : '<button id="empty-refresh" class="pay">' + failure.actionLabel + '</button>';
    invoiceDrawer.close();
    $("invoice-list").innerHTML = '<div class="empty"><div class="empty-icon">!</div><h3>' + escapeHtml(failure.title) + '</h3><p>' + escapeHtml(failure.message) + '</p>' + action + '</div>';
    if (authRevoked) $("empty-reconnect").addEventListener("click", connectGmail);
    else $("empty-refresh").addEventListener("click", load);
  } finally {
    setInboxBusy(false);
  }
}

async function scheduleInvoice() {
  const invoice = state.selected;
  if (!invoice || invoice.agentDecision !== "SCHEDULE") return;
  const confirmed = window.confirm(
    "Queue " + invoice.invoiceNumber + " for payment review on its due date?\n\n" +
    "This records a schedule only. No funds move now, and vendor verification plus live policy preflight will still be required before any payment."
  );
  if (!confirmed) return;
  const button = $("schedule-button");
  button.disabled = true;
  button.textContent = "Queueing…";
  try {
    const response = await apiFetch("/api/invoices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "schedule", invoiceNumber: invoice.invoiceNumber, network: state.business?.wallet_blockchain })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to schedule invoice");
    toast(data.idempotent ? "Invoice was already queued" : "Invoice queued for review");
    await load();
  } catch (error) {
    toast(error.message || "Unable to schedule invoice");
    button.disabled = false;
    button.textContent = "Queue for due date";
  }
}

async function cancelScheduledInvoice() {
  const invoice = state.selected;
  if (!invoice) return;
  const dueReview = invoice.settlement?.status === "review";
  if (!window.confirm((dueReview ? "Release " : "Cancel ") + "the review queue for " + invoice.invoiceNumber + "?\n\nNo payment will be submitted.")) return;
  const button = $("cancel-schedule");
  button.disabled = true;
  button.textContent = "Cancelling…";
  try {
    const response = await apiFetch("/api/invoices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel_schedule", invoiceNumber: invoice.invoiceNumber, network: state.business?.wallet_blockchain })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to cancel schedule");
    toast(data.idempotent ? "Invoice was already outside the review queue" : dueReview ? "Invoice released for payment review" : "Invoice schedule cancelled");
    await load();
  } catch (error) {
    toast(error.message || "Unable to cancel schedule");
    button.disabled = false;
    button.textContent = "Cancel schedule";
  }
}

async function rescheduleScheduledInvoice() {
  const invoice = state.selected;
  if (!invoice || invoice.settlement?.status !== "scheduled") return;
  const current = invoice.schedule?.scheduledFor || "";
  const scheduledFor = window.prompt("Enter the new review time as an ISO date (for example 2026-10-10T09:00:00Z). No payment will be submitted.", current);
  if (!scheduledFor) return;
  if (!window.confirm("Reschedule " + invoice.invoiceNumber + " for " + scheduledFor + "?\n\nThis changes only the review queue. Vendor verification and live policy preflight will still be required before any payment.")) return;
  const button = $("reschedule-button");
  button.disabled = true;
  button.textContent = "Rescheduling…";
  try {
    const response = await apiFetch("/api/invoices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reschedule", invoiceNumber: invoice.invoiceNumber, scheduledFor, network: state.business?.wallet_blockchain })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to reschedule invoice");
    toast("Invoice review queue rescheduled");
    await load();
  } catch (error) {
    toast(error.message || "Unable to reschedule invoice");
    button.disabled = false;
    button.textContent = "Reschedule";
  }
}

async function settle() {
  const invoice = state.selected;
  if (!invoice) return;
  const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
  const vendor = state.vendors.find((item) => item.name === invoice.vendor);
  const recipient = vendor?.recipient_address || "the verified vendor address";
  const walletAddress = state.business?.wallet_address || "Unavailable";
  const policyVault = state.business?.policy_contract_address || "Unavailable";
  const amount = Number(invoice.amount || 0).toFixed(6);
  const confirmed = window.confirm(
    "Confirm settlement on " + network + "?\n\n" +
    "Invoice: " + invoice.invoiceNumber + "\n" +
    "Amount: " + amount + " " + invoice.currency + "\n" +
    "Vendor: " + invoice.vendor + "\n" +
    "Recipient: " + recipient + "\n" +
    "Business wallet: " + walletAddress + "\n" +
    "Policy vault: " + policyVault + "\n\n" +
    "This submits a real payment from this business's dedicated Circle wallet. InboxPay will run live policy checks and reconcile the Arc receipt. Continue only if every detail matches."
  );
  if (!confirmed) return;
  $("pay-button").disabled = true;
  $("pay-button").textContent = "Executing…";
  try {
    const response = await apiFetch("/api/pay", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        invoiceNumber: invoice.invoiceNumber,
        network: state.business?.wallet_blockchain,
        ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {})
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Settlement failed");
    toast(data.result?.status === "processing"
      ? "Payment submitted; InboxPay is recovering the Arc receipt"
      : "Payment settled and reconciled on Arc");
    await load();
  } catch (error) {
    toast(error.message);
    $("pay-button").disabled = false;
    $("pay-button").textContent = invoice.settlement?.status === "failed"
      ? "Review & retry on Arc ↗"
      : "Review & settle on Arc ↗";
  }
}

function setDestination(destination, updateUrl = true) {
  invoiceDrawer.close();
  const activity = $("activity-modal");
  activateDestination(destination, {
    inbox: null,
    payments: activity,
    policy: $("policy-modal"),
    audit: activity,
    business: $("business-modal"),
    vendors: $("vendor-modal"),
    notifications: $("notifications-modal")
  }, document.querySelectorAll(".nav[data-nav]"), document.querySelector(".content"));
  activeDestination = destination;
  const titles = {
    inbox: "Invoice queue",
    payments: "Payments",
    policy: "Payment settings",
    audit: "Audit trail",
    business: "Business profile",
    vendors: "Vendors",
    notifications: "Notifications"
  };
  document.title = (titles[destination] || "InboxPay") + " — InboxPay";
  if (window.matchMedia("(max-width: 800px)").matches) {
    const activeNav = document.querySelector('.nav[data-nav="' + destination + '"]');
    window.requestAnimationFrame(() => activeNav?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
      inline: "center"
    }));
  }
  if (updateUrl && destinationFromHash(window.location.hash) !== destination) {
    const base = window.location.pathname + window.location.search;
    window.history.pushState({ destination }, "", destination === "inbox" ? base : base + "#" + destination);
  }
}

async function openDestination(destination, options = {}) {
  if (state.businessNameRequired) { setDestination("inbox", options.updateUrl !== false); return; }
  if (destination === "payments" || destination === "audit") return openActivity(destination, options);
  if (destination === "policy") return openPolicyModal(options);
  if (destination === "business") return openBusinessModal(options);
  if (destination === "vendors") return openVendorModal(options);
  if (destination === "notifications") return openNotifications(options);
  setDestination("inbox", options.updateUrl !== false);
}

async function init() {
  try {
    setDestination("inbox", false);
    const configResponse = await fetch("/api/config");
    const config = await readJsonResponse(configResponse);
    if (!configResponse.ok) throw new Error(config.error || "InboxPay configuration unavailable");
    state.previewReadOnly = config.previewReadOnly === true;
    $("preview-notice").hidden = !state.previewReadOnly;
    if (state.previewReadOnly) {
      const lockPreviewControls = () => {
        document.querySelectorAll('#app-shell form input, #app-shell form select, #app-shell form button, .verify-vendor, .revoke-vendor, #network-switch, #connect-gmail, #provision-wallet, #fund-test-wallet, #policy-pause, #policy-allowance, #policy-autonomy, #policy-migrate, #pay-button, #schedule-button, #reschedule-button, #cancel-schedule, #notification-connect, #notification-test, #notification-disconnect').forEach((node) => {
          node.disabled = true;
          node.title = "Disabled in the read-only QA preview";
        });
      };
      new MutationObserver(lockPreviewControls).observe($("app-shell"), { childList: true, subtree: true });
      new MutationObserver(lockPreviewControls).observe($("detail"), { childList: true, subtree: true });
      lockPreviewControls();
    }

    state.supabase = createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    $("auth-form").addEventListener("submit", authSubmit);
    $("auth-signup").addEventListener("click", signup);
    $("auth-google").addEventListener("click", signInWithGoogle);
    $("connect-gmail").addEventListener("click", connectGmail);
    $("network-switch").addEventListener("change", switchNetwork);
    $("edit-business").addEventListener("click", openBusinessModal);
    $("close-business").addEventListener("click", closeBusinessModal);
    $("business-form").addEventListener("submit", saveBusinessName);
    $("withdrawal-form").addEventListener("submit", submitWalletWithdrawal);
    $("withdrawal-recipient").addEventListener("input", () => { state.withdrawalRequestId = null; });
    $("withdrawal-amount").addEventListener("input", () => { state.withdrawalRequestId = null; });
    $("nav-business").addEventListener("click", openBusinessModal);
    document.querySelector('[data-nav="inbox"]').addEventListener("click", () => setDestination("inbox"));
    $("nav-vendors").addEventListener("click", openVendorModal);
    $("nav-notifications").addEventListener("click", openNotifications);
    $("close-notifications").addEventListener("click", () => setDestination("inbox"));
    $("notification-connect").addEventListener("click", connectTelegram);
    $("notification-refresh").addEventListener("click", () => loadNotifications().catch((error) => toast(error.message)));
    $("notification-test").addEventListener("click", testTelegramNotification);
    $("notification-disconnect").addEventListener("click", disconnectTelegram);
    $("add-vendor").addEventListener("click", openVendorModal);
    $("close-vendor").addEventListener("click", closeVendorModal);
    $("vendor-form").addEventListener("submit", addVendor);
    $("rail-open-policy").addEventListener("click", openPolicyModal);
    $("rail-open-payments").addEventListener("click", () => openActivity("payments"));
    $("open-policy").addEventListener("click", openPolicyModal);
    $("open-policy-top").addEventListener("click", openPolicyModal);
    $("open-payments").addEventListener("click", () => openActivity("payments"));
    $("open-audit").addEventListener("click", () => openActivity("audit"));
    $("open-payments-top").addEventListener("click", () => openActivity("payments"));
    $("open-audit-top").addEventListener("click", () => openActivity("audit"));
    $("close-activity").addEventListener("click", closeActivityModal);
    $("close-policy").addEventListener("click", closePolicyModal);
    $("queue-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-queue-filter]");
      if (!button) return;
      state.queue.filter = button.dataset.queueFilter;
      renderList();
    });
    $("queue-search").addEventListener("input", (event) => {
      state.queue.query = event.currentTarget.value;
      renderList();
    });
    $("activity-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button || !state.activity.kind) return;
      state.activity.filter = button.dataset.filter;
      renderActivity(state.activity.kind, state.activity.rows, state.activity.data);
    });
    $("activity-search").addEventListener("input", (event) => {
      if (!state.activity.kind) return;
      state.activity.query = event.currentTarget.value;
      renderActivity(state.activity.kind, state.activity.rows, state.activity.data);
    });
    $("policy-form").addEventListener("submit", savePolicy);
    $("policy-migrate").addEventListener("click", migratePolicyVault);
    $("policy-pause").addEventListener("click", togglePolicyPause);
    $("policy-allowance").addEventListener("click", togglePolicyAllowance);
    $("policy-autonomy").addEventListener("click", togglePaymentAutonomy);
    $("copy-wallet").addEventListener("click", () => copyText(state.business.wallet_address, "Wallet address"));
    $("sign-out").addEventListener("click", async () => {
      const button = $("sign-out"); button.disabled = true; button.textContent = "Signing out…";
      try { await state.supabase.auth.signOut(); } finally { button.disabled = false; button.textContent = "Sign out"; }
    });
    $("refresh").addEventListener("click", () => {
      toast("Syncing the business inbox…");
      load();
    });
    $("retry-bootstrap").addEventListener("click", async () => {
      const button = $("retry-bootstrap");
      button.disabled = true;
      button.textContent = "Retrying…";
      try { await bootstrap(); }
      catch { /* Persistent notice remains visible; no automatic retry. */ }
      finally { button.disabled = false; button.textContent = "Retry workspace"; }
    });
    window.addEventListener("popstate", () => {
      if (!state.session || !state.business) return;
      openDestination(destinationFromHash(window.location.hash), { updateUrl: false }).catch((error) => toast(error.message));
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && activeDestination !== "inbox") setDestination("inbox");
    });

    state.supabase.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (event === "SIGNED_OUT") {
        state.user = null;
        state.business = null;
        state.businessNameRequired = false;
        state.bootstrapError = false;
        state.gmail = null;
        state.wallet = null;
        state.policy = null;
        state.policyConfig = null;
        state.onchainPolicy = null;
        state.policyAllowance = false;
        state.queue = { filter: "all", query: "" };
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
      const authError = new URLSearchParams(window.location.search).get("error_description");
      if (authError) {
        authDialog.open();
        setAuthMessage("Your sign-in link could not be completed. Please start a fresh sign-in. " + authError, true);
      }
      return;
    }

    state.user = state.session.user;
    await bootstrap();
    await openDestination(destinationFromHash(window.location.hash), { updateUrl: false });

    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") {
      toast("Business Gmail connected");
      history.replaceState({}, "", "/");
    } else if (params.get("gmail") === "error") {
      toast(params.get("message") || "Gmail connection failed");
      history.replaceState({}, "", "/");
    }
  } catch (error) {
    if (state.session) {
      showApp();
      toast(error.message || "InboxPay failed to initialize");
      renderAccount();
      renderSetup();
    } else {
      showAuth();
      setAuthMessage(error.message || "InboxPay failed to initialize", true);
    }
  }
}

init();
