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
  policyConfig: null,
  onchainPolicy: null,
  policyAllowance: false,
  vendors: [],
  vendorRevocationSupported: null,
  preflight: null,
  activity: { kind: null, rows: [] }
};

let bootstrapPromise = null;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    REVIEW: ["escalate", "Review"]
  };
  const [kind, label] = map[decision] || ["hold", decision || "Unknown"];
  return '<span class="status ' + escapeHtml(kind) + '">' + escapeHtml(label) + '</span>';
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
      options: {
        emailRedirectTo: window.location.origin + "/",
        data: { business_name: email.split("@")[1] || "My Business" }
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
  const headers = { ...(options.headers || {}), ...(await authHeader()) };
  return fetch(path, { ...options, headers });
}

async function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    showApp();

    const response = await apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Business onboarding failed");
    state.business = data.business;

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
  } finally {
    bootstrapPromise = null;
  }
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
  } catch (error) {
    state.policy = null;
    state.onchainPolicy = null;
  }
}

async function loadPolicyConfig() {
  try {
    const response = await apiFetch("/api/policy");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Policy configuration unavailable");
    state.policyConfig = data.policy || null;
  } catch (error) {
    state.policyConfig = null;
  }
}

function renderAccount() {
  $("business-name").textContent = state.business?.name || "Business";
  const networkLabel = state.business?.wallet_blockchain === "ARC-TESTNET"
    ? "Arc Testnet"
    : state.business?.wallet_blockchain === "ARC"
      ? "Arc Mainnet"
      : "Arc";
  $("network-label").textContent = networkLabel;
  $("wallet-address").textContent = state.business?.wallet_address
    ? (state.business.wallet_blockchain || "Arc") + " · Circle wallet · " + state.business.wallet_address +
      (state.wallet ? " · " + Number(state.wallet.balance || 0).toFixed(2) + " USDC" : "")
    : "Wallet provisioning…";
  $("copy-wallet").hidden = !state.business?.wallet_address;
  $("connect-gmail").textContent = state.gmail?.status === "connected" ? "Gmail connected ✓" : "Connect Gmail";
  $("connect-gmail").disabled = state.gmail?.status === "connected";
  $("feed-label").textContent = state.gmail?.status === "connected" ? "live Gmail operator" : "connect Gmail";
  $("feed-dot").textContent = state.gmail?.status === "connected" ? "●" : "○";
}

function renderSetup() {
  const node = $("setup-card");
  const gmailReady = state.gmail?.status === "connected";
  const walletReady = state.business?.wallet_status === "ready";
  const walletFunded = Number(state.wallet?.balance || 0) > 0;
  const testnetNeedsFunding = walletReady && state.business?.wallet_blockchain === "ARC-TESTNET" && !walletFunded;
  const policyReady = state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);

  if (gmailReady && walletReady && policyReady) {
    node.hidden = true;
    return;
  }

  node.hidden = false;
  node.innerHTML =
    '<div><label>SETUP</label><h3>Finish connecting your business</h3><p>' +
    (!walletReady ? "Create the dedicated Circle wallet that will hold this business's USDC. " : "") +
    (!gmailReady ? "Connect the Gmail inbox your business actually uses for invoices. " : "") +
    (testnetNeedsFunding ? "Fund the Arc Testnet wallet so it can pay deployment gas. " : "") +
    (!policyReady && walletReady && !testnetNeedsFunding ? "Deploy the onchain policy guard before autonomous payments can run. " : "") +
    '</p></div><div class="setup-status">' +
    '<span class="' + (walletReady ? "done" : "") + '">✓ Dedicated Circle wallet</span>' +
    (!walletReady
      ? '<div class="network-picker"><label for="wallet-network">Network</label><select id="wallet-network"><option value="ARC-TESTNET">Arc Testnet</option><option value="ARC">Arc Mainnet</option></select></div><button id="provision-wallet" class="ghost">Create dedicated wallet</button>'
      : '') +
    (testnetNeedsFunding ? '<button id="fund-test-wallet" class="ghost">Fund test wallet</button>' : '') +
    '<span class="' + (gmailReady ? "done" : "") + '">✓ Business Gmail</span>' +
    '<span class="' + (policyReady ? "done" : "") + '">✓ Onchain payment policy</span>' +
    (walletReady && !policyReady
      ? '<button id="setup-policy" class="ghost"' + (testnetNeedsFunding || state.business?.policy_contract_status === "deploying" ? ' disabled' : '') + '>' +
        (testnetNeedsFunding ? "Fund wallet first" : state.business?.policy_contract_status === "deploying" ? "Policy deployment running…" : "Review policy & deploy") + '</button>'
      : policyReady
        ? '<span class="setup-contract">Vault · ' + shortAddress(state.business.policy_contract_address) +
          (state.wallet?.policyVaultBalance != null ? " · " + Number(state.wallet.policyVaultBalance).toFixed(2) + " USDC" : "") +
          '</span>'
        : '') +
    '</div>';

  if (!walletReady) $("provision-wallet").addEventListener("click", provisionWallet);
  if (testnetNeedsFunding) $("fund-test-wallet").addEventListener("click", fundTestWallet);
  if (walletReady && !policyReady && !testnetNeedsFunding && state.business?.policy_contract_status !== "deploying") {
    $("setup-policy").addEventListener("click", openPolicyModal);
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
      body: JSON.stringify({ action: "fund_testnet" })
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
  const network = $("wallet-network")?.value || "ARC-TESTNET";
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

function policyIsReady() {
  return state.business?.policy_contract_status === "ready" && Boolean(state.business?.policy_contract_address);
}

function invoicePaymentReady(invoice) {
  const vendor = state.vendors.find((item) => item.name === invoice.vendor);
  const paused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  return invoice.agentDecision === "PAY_NOW" &&
    !invoice.settlement?.reconciled &&
    invoice.settlement?.status !== "processing" &&
    invoice.settlement?.status !== "review" &&
    invoice.settlement?.status !== "scheduled" &&
    policyIsReady() &&
    state.policyAllowance &&
    !paused &&
    vendor?.status === "verified" &&
    vendor?.onchain_status === "registered";
}

function openBusinessModal() {
  $("business-name-input").value = state.business?.name || "";
  $("business-message").textContent = "";
  $("business-message").className = "auth-message";
  $("business-modal").hidden = false;
  $("business-name-input").focus();
}

function closeBusinessModal() {
  $("business-modal").hidden = true;
  $("business-message").textContent = "";
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

async function loadPreflight(invoice = state.selected) {
  state.preflight = null;
  if (!invoice?.invoiceNumber) {
    renderDetail();
    return;
  }
  try {
    const response = await apiFetch("/api/preflight?invoice=" + encodeURIComponent(invoice.invoiceNumber));
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Payment preflight unavailable");
    if (state.selected?.invoiceNumber === invoice.invoiceNumber) {
      state.preflight = data.preflight || null;
      renderStats();
      renderDetail();
    }
  } catch (error) {
    if (state.selected?.invoiceNumber === invoice.invoiceNumber) {
      state.preflight = {
        eligible: false,
        checks: [{ key: "preflight", label: "Onchain execution preflight", ok: false, value: "Unavailable", reason: error.message || "Payment preflight unavailable" }],
        reasons: [error.message || "Payment preflight unavailable"]
      };
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
  $("policy-submit").textContent = ready ? "Update onchain policy" : "Save and deploy this policy";

  const chainState = $("policy-chain-state");
  chainState.innerHTML = ready
    ? '<div><strong>Live on ' + network + '</strong><span>' + state.business.policy_contract_address + '</span><button class="text-action copy-address" type="button" data-address="' + state.business.policy_contract_address + '" data-label="Policy vault address">Copy address</button></div><b class="' + (paused ? "paused" : "ready") + '">' + (paused ? "Payments paused" : "Enforced onchain") + '</b>'
    : '<div><strong>Not deployed yet</strong><span>Review these values before creating this business\'s policy vault.</span></div><b>Draft</b>';

  const pauseButton = $("policy-pause");
  pauseButton.hidden = !ready;
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
  allowanceControl.hidden = !ready;
  $("policy-allowance-title").textContent = state.policyAllowance ? "USDC access authorized" : "USDC access not authorized";
  $("policy-allowance-note").textContent = state.policyAllowance
    ? "The vault can move this wallet's USDC only through the enforced policy checks."
    : "The vault cannot move funds until this business explicitly authorizes it.";
  const allowanceButton = $("policy-allowance");
  allowanceButton.dataset.authorized = String(state.policyAllowance);
  allowanceButton.textContent = state.policyAllowance ? "Revoke USDC access" : "Authorize vault";
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
      body: JSON.stringify({ action: "migrate", confirmMainnet: true })
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

async function openPolicyModal() {
  $("policy-modal").hidden = false;
  setPolicyMessage("Loading this business's policy…");
  await Promise.all([loadPolicyConfig(), loadPolicyStatus()]);
  renderPolicyModal();
  setPolicyMessage(state.policyConfig ? "" : "Policy configuration is unavailable. Try again before deploying.", !state.policyConfig);
}

function closePolicyModal() {
  $("policy-modal").hidden = true;
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
        body: JSON.stringify({ action: "deploy", ...(mainnet ? { confirmMainnet: true } : {}) })
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
      body: JSON.stringify({ paused: nextPaused, ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {}) })
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
      body: JSON.stringify({ action, ...(state.business?.wallet_blockchain === "ARC" ? { confirmMainnet: true } : {}) })
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


function renderStats() {
  const settled = state.invoices.filter((x) => x.settlement?.reconciled === true);
  const payable = state.invoices.filter(invoicePaymentReady);
  const held = state.invoices.filter((x) => !x.settlement?.reconciled && (
    x.agentDecision !== "PAY_NOW" ||
    ["processing", "failed", "review"].includes(x.settlement?.status)
  ));
  const total = payable.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  $("invoice-count").textContent = state.invoices.length;
  $("payment-count").textContent = settled.length;
  $("queue-count").textContent = state.invoices.length + (state.invoices.length === 1 ? " invoice" : " invoices");
  $("stats").innerHTML = [
    ["◎", "Ready to review", total.toFixed(2) + " USDC", payable.length + " policy-eligible invoices"],
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
    const displayDecision = invoice.settlement?.reconciled
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
    return '<button class="invoice-row' + selected + '" data-invoice="' +
      encodeURIComponent(invoice.invoiceNumber) + '"><div class="avatar">' +
      escapeHtml((invoice.vendor || "V").slice(0, 1)) + '</div><div class="main"><div class="row-title"><strong>' +
      escapeHtml(invoice.vendor || "Unknown vendor") + '</strong>' + status(displayDecision) + '</div><span class="sub">' +
      escapeHtml(invoice.invoiceNumber || "Missing invoice number") + ' · due ' + escapeHtml(invoice.dueDate || "not found") +
      '</span></div><div class="amount">' + Number(invoice.amount || 0).toFixed(2) + ' ' +
      escapeHtml(invoice.currency || "") + '</div><span class="chev">›</span></button>';
  }).join("");

  document.querySelectorAll(".invoice-row").forEach((button) => {
    button.addEventListener("click", () => {
      const number = decodeURIComponent(button.dataset.invoice);
      state.selected = state.invoices.find((x) => x.invoiceNumber === number);
      state.preflight = null;
      renderList();
      renderDetail();
      loadPreflight(state.selected);
    });
  });
}

function renderDetail() {
  const invoice = state.selected;
  if (!invoice) return;
  const settled = invoice.settlement?.reconciled === true;
  const processing = invoice.settlement?.status === "processing";
  const reviewRequired = invoice.settlement?.status === "review";
  const scheduled = invoice.settlement?.status === "scheduled";
  const scheduleDecision = invoice.agentDecision === "SCHEDULE" && !settled && !processing && !reviewRequired && !scheduled;
  const decisionReady = invoice.agentDecision === "PAY_NOW" && !settled;
  const vaultReady = policyIsReady();
  const policyPaused = Boolean(state.onchainPolicy?.paused ?? state.policyConfig?.paused);
  const vendor = state.vendors.find((item) => item.name === invoice.vendor);
  const vendorReady = vendor?.status === "verified" && vendor?.onchain_status === "registered";
  const preflight = state.preflight?.invoiceNumber === invoice.invoiceNumber ? state.preflight : null;
  const ready = Boolean(preflight?.eligible);
  const detailStatus = settled
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
  const reasons = settled
    ? ["Payment executed and reconciled on " + settlementNetwork + "."]
    : (invoice.decisionReasons?.length ? invoice.decisionReasons : ["No decision reason recorded."]);
  const reasonsHtml = '<ul>' + reasons.map((reason) => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul>';
  const gateReasons = preflight?.reasons || ["Checking the live policy vault and payment state…"];
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
  const scheduleHtml = scheduled
    ? '<div class="schedule-card"><div><strong>Queued for review</strong><span>' +
      escapeHtml(invoice.schedule?.scheduledFor ? new Date(invoice.schedule.scheduledFor).toLocaleString() : "Target pending audit reconciliation") +
      '</span><small>Vendor verification and live policy preflight are still required. No payment has been submitted.</small></div><div class="schedule-actions"><button id="reschedule-button" class="ghost" type="button">Reschedule</button><button id="cancel-schedule" class="ghost" type="button">Cancel schedule</button></div></div>'
    : scheduleDecision
      ? '<div class="schedule-card"><div><strong>Schedule this invoice</strong><span>Queue for review on the due date</span><small>This records a durable review queue entry only. It will not move funds or bypass vendor verification.</small></div><button id="schedule-button" class="ghost" type="button">Queue for due date</button></div>'
      : "";
  $("detail").innerHTML = '<div class="detail-inner"><div class="detail-top"><div><label>INVOICE</label><h2>' +
    escapeHtml(invoice.invoiceNumber || "Needs review") + '</h2></div>' + status(detailStatus) + '</div>' +
    '<div class="merchant"><div class="avatar big">' + escapeHtml(vendorInitial) + '</div><div><strong>' +
    escapeHtml(invoice.vendor || "Unknown vendor") + '</strong><span>' + escapeHtml(invoice.currency || "Unknown") +
    ' settlement · due ' + escapeHtml(invoice.dueDate || "not found") + '</span></div></div><div class="big-amount">' +
    Number(invoice.amount || 0).toFixed(2) + ' <span>' + escapeHtml(invoice.currency || "") + '</span></div><div class="decision"><div class="decision-head">● Agent reasoning</div>' +
    reasonsHtml + '<div class="confidence"><span>Extraction confidence</span><b>' +
    escapeHtml(invoice.extraction?.confidence || "unknown") + '</b></div></div>' +
    gateHtml + scheduleHtml + '<div class="checks">' + checksHtml +
    (processing ? checkRow("Payment recovery", "In progress") : reviewRequired ? checkRow("Payment recovery", "Manual review") : "") +
    '</div>' + (settled ? '<div class="settlement"><span>Arc confirmation</span><b>Reconciliation PASS</b></div>' : "") +
    '<button id="pay-button" class="pay"' + (ready ? "" : " disabled") +
    '>' + (ready ? (invoice.settlement?.status === "failed" ? "Review & retry on Arc ↗" : "Review & settle on Arc ↗") : settled ? "Settled on Arc ✓" : processing ? "Payment submitted · recovering…" : scheduled ? "Queued for review" : reviewRequired ? "Payment under review" : scheduleDecision ? "Schedule this invoice above" : preflight ? "Payment blocked" : "Checking payment gates…") + '</button></div>';

  if (ready) $("pay-button").addEventListener("click", settle);
  if (scheduleDecision) $("schedule-button").addEventListener("click", scheduleInvoice);
  if (scheduled) {
    $("reschedule-button").addEventListener("click", rescheduleScheduledInvoice);
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
  $("activity-modal").hidden = true;
  $("activity-message").textContent = "";
}

function formatActivityDate(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function renderActivity(kind, rows) {
  const node = $("activity-list");
  if (!rows.length) {
    node.innerHTML = '<div class="activity-empty">No ' + (kind === "payments" ? "settlement attempts" : "audit events") + " recorded for this business yet.</div>";
    return;
  }
  if (kind === "payments") {
    node.innerHTML = rows.map((payment) => '<article class="activity-row"><div><strong>' + escapeHtml(payment.vendor || "Unknown vendor") + '</strong><span>' +
      escapeHtml(payment.invoiceNumber || "Missing invoice number") + ' · ' + escapeHtml(formatActivityDate(payment.updatedAt)) + '</span></div><div class="activity-value"><b>' +
      Number(payment.amount || 0).toFixed(2) + ' ' + escapeHtml(payment.currency || "") + '</b><span class="activity-status ' + escapeHtml(payment.status || "") + '">' +
      escapeHtml(payment.status || "unknown") + '</span>' + (payment.paymentTxHash ? '<a href="' + (payment.network === "ARC" ? "https://arcscan.app/tx/" : "https://testnet.arcscan.app/tx/") + encodeURIComponent(payment.paymentTxHash) + '" target="_blank" rel="noreferrer">' + escapeHtml(payment.paymentTxHash.slice(0, 10) + "…") + '</a>' : '') + '</div></article>').join("");
    return;
  }
  node.innerHTML = rows.map((event) => '<article class="activity-row"><div><strong>' + escapeHtml(event.event_type || "event") + '</strong><span>' +
    escapeHtml(event.actor || "system") + ' · ' + escapeHtml(formatActivityDate(event.created_at)) + '</span></div><div class="activity-value"><span>' +
    escapeHtml(event.invoice_id ? "Invoice event" : "Business event") + '</span><details><summary>Details</summary><pre>' + escapeHtml(JSON.stringify(event.data || {}, null, 2)) + '</pre></details></div></article>').join("");
}

async function openActivity(kind) {
  $("activity-modal").hidden = false;
  $("activity-kicker").textContent = kind === "payments" ? "SETTLEMENTS" : "AUDIT TRAIL";
  $("activity-title").textContent = kind === "payments" ? "Payments" : "Audit trail";
  $("activity-context").textContent = kind === "payments"
    ? "Every submitted, failed, processing, or reconciled payment for this business."
    : "Business-scoped evidence for policy, vendor, wallet, and settlement decisions.";
  $("activity-message").textContent = "Loading live activity…";
  $("activity-message").className = "auth-message";
  $("activity-list").innerHTML = "";
  try {
    const response = await apiFetch("/api/activity?view=" + encodeURIComponent(kind));
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Activity unavailable");
    state.activity = { kind, rows: kind === "payments" ? (data.payments || []) : (data.events || []) };
    $("activity-message").textContent = "";
    renderActivity(kind, state.activity.rows);
  } catch (error) {
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

async function openVendorModal() {
  $("vendor-modal").hidden = false;
  $("vendor-name").focus();
  await loadVendors();
}

async function loadVendors() {
  try {
    const response = await apiFetch("/api/vendors");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Unable to load vendors");
    state.vendors = data.vendors || [];
    state.vendorRevocationSupported = data.vendorRevocationSupported ?? null;
    renderVendors();
  } catch (error) {
    $("vendor-message").textContent = error.message;
    $("vendor-message").className = "auth-message error";
  }
}

function renderVendors() {
  const node = $("vendor-list");
  if (state.vendorRevocationSupported === false) {
    $("vendor-message").textContent = "This vault version cannot revoke vendor addresses onchain. InboxPay can block a vendor in its registry; full chain revocation needs a vault migration.";
    $("vendor-message").className = "auth-message error";
  }
  if (!state.vendors.length) {
    node.innerHTML = '<div class="vendor-empty">No vendor addresses registered yet.</div>';
    return;
  }
  node.innerHTML = state.vendors.map((vendor) =>
    '<div class="vendor-row"><div><strong>' + escapeHtml(vendor.name) + '</strong><span>' +
    escapeHtml(vendor.recipient_address) +
    '</span><button class="text-action copy-address" type="button" data-address="' + escapeHtml(vendor.recipient_address) + '" data-label="Vendor address">Copy address</button></div><div><b class="vendor-status ' + escapeHtml(["missing", "unavailable"].includes(vendor.onchain_status) ? "review" : vendor.status) + '">' +
    escapeHtml(vendor.onchain_status === "registered" ? "onchain" : vendor.onchain_status === "missing" ? "not onchain" : vendor.onchain_status === "unavailable" ? "chain unavailable" : vendor.status) + '</b>' +
    (vendor.status === "review" || vendor.onchain_status === "missing"
      ? '<button class="ghost verify-vendor" data-id="' + escapeHtml(vendor.id) + '">' + (vendor.onchain_status === "missing" ? "Register onchain" : "Verify") + '</button>'
      : "") +
    (vendor.status === "verified" || vendor.onchain_status === "registered"
      ? '<button class="ghost revoke-vendor" data-id="' + escapeHtml(vendor.id) + '">Revoke vendor</button>'
      : "") +
    '</div></div>'
  ).join("");

  document.querySelectorAll(".verify-vendor").forEach((button) => {
    button.addEventListener("click", () => verifyVendor(button.dataset.id));
  });
  document.querySelectorAll(".revoke-vendor").forEach((button) => {
    button.addEventListener("click", () => revokeVendor(button.dataset.id));
  });
  document.querySelectorAll("#vendor-list .copy-address").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.address, button.dataset.label));
  });
}

async function verifyVendor(id) {
  try {
    const vendor = state.vendors.find((item) => item.id === id);
    if (!vendor) throw new Error("Vendor not found");
    const network = state.business?.wallet_blockchain === "ARC" ? "Arc Mainnet" : "Arc Testnet";
    const onchain = policyIsReady();
    const prompt = "Verify " + vendor.name + " for payments?\n\nRecipient: " + vendor.recipient_address +
      "\nNetwork: " + network + (onchain ? "\n\nThis updates the business's onchain vendor registry." : "\n\nThis saves the verification. After the vault is deployed, InboxPay will require a separate onchain registration before payment.");
    if (!window.confirm(prompt)) return;
    const response = await apiFetch("/api/vendors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
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

async function connectGmail() {
  try {
    const response = await apiFetch("/api/gmail/start");
    const data = await readJsonResponse(response);
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
    state.preflight = null;
    renderStats();
    renderList();
    $("detail").innerHTML = '<div class="empty"><div class="empty-icon">✉</div><h3>Connect the business inbox</h3><p>InboxPay only evaluates invoices from a real connected Gmail account.</p><button id="empty-connect" class="pay">Connect Gmail</button></div>';
    $("empty-connect").addEventListener("click", connectGmail);
    return;
  }

  $("refresh").disabled = true;
  try {
    const response = await apiFetch("/api/invoices");
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Invoice data unavailable");
    state.invoices = data.invoices || [];
    state.selected = state.selected
      ? state.invoices.find((x) => x.invoiceNumber === state.selected.invoiceNumber) || null
      : state.invoices[0] || null;
    state.preflight = null;
    renderStats();
    renderList();
    renderDetail();
    await loadPreflight(state.selected);
  } catch (error) {
    toast(error.message);
  } finally {
    $("refresh").disabled = false;
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
      body: JSON.stringify({ action: "schedule", invoiceNumber: invoice.invoiceNumber })
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
  if (!window.confirm("Cancel the review queue for " + invoice.invoiceNumber + "?\n\nNo payment will be submitted.")) return;
  const button = $("cancel-schedule");
  button.disabled = true;
  button.textContent = "Cancelling…";
  try {
    const response = await apiFetch("/api/invoices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel_schedule", invoiceNumber: invoice.invoiceNumber })
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Unable to cancel schedule");
    toast(data.idempotent ? "Invoice was already unscheduled" : "Invoice schedule cancelled");
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
      body: JSON.stringify({ action: "reschedule", invoiceNumber: invoice.invoiceNumber, scheduledFor })
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
  const confirmed = window.confirm(
    "Settle " + Number(invoice.amount || 0).toFixed(2) + " " + invoice.currency + " to " + invoice.vendor + " on " + network + "?\n\n" +
    "Invoice: " + invoice.invoiceNumber + "\nRecipient: " + recipient + "\n\nInboxPay will submit the payment through this business's policy vault and reconcile the Arc receipt."
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

async function init() {
  try {
    const configResponse = await fetch("/api/config");
    const config = await readJsonResponse(configResponse);
    if (!configResponse.ok) throw new Error(config.error || "InboxPay configuration unavailable");

    state.supabase = createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    $("auth-form").addEventListener("submit", authSubmit);
    $("auth-signup").addEventListener("click", signup);
    $("auth-google").addEventListener("click", signInWithGoogle);
    $("connect-gmail").addEventListener("click", connectGmail);
    $("edit-business").addEventListener("click", openBusinessModal);
    $("close-business").addEventListener("click", closeBusinessModal);
    $("business-form").addEventListener("submit", saveBusinessName);
    $("add-vendor").addEventListener("click", openVendorModal);
    $("close-vendor").addEventListener("click", closeVendorModal);
    $("vendor-form").addEventListener("submit", addVendor);
    $("open-policy").addEventListener("click", openPolicyModal);
    $("open-policy-top").addEventListener("click", openPolicyModal);
    $("open-payments").addEventListener("click", () => openActivity("payments"));
    $("open-audit").addEventListener("click", () => openActivity("audit"));
    $("open-payments-top").addEventListener("click", () => openActivity("payments"));
    $("open-audit-top").addEventListener("click", () => openActivity("audit"));
    $("close-activity").addEventListener("click", closeActivityModal);
    $("close-policy").addEventListener("click", closePolicyModal);
    $("policy-form").addEventListener("submit", savePolicy);
    $("policy-migrate").addEventListener("click", migratePolicyVault);
    $("policy-pause").addEventListener("click", togglePolicyPause);
    $("policy-allowance").addEventListener("click", togglePolicyAllowance);
    $("copy-wallet").addEventListener("click", () => copyText(state.business.wallet_address, "Wallet address"));
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
        state.policyConfig = null;
        state.onchainPolicy = null;
        state.policyAllowance = false;
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
