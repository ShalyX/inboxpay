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
    (!walletReady ? "Create the dedicated Circle wallet that will hold this business's USDC. " : "") +
    (!gmailReady ? "Connect the Gmail inbox your business actually uses for invoices. " : "") +
    (!policyReady && walletReady ? "Deploy the onchain policy guard before autonomous payments can run. " : "") +
    '</p></div><div class="setup-status">' +
    '<span class="' + (walletReady ? "done" : "") + '">✓ Dedicated Circle wallet</span>' +
    (!walletReady
      ? '<div class="network-picker"><label for="wallet-network">Network</label><select id="wallet-network"><option value="ARC-TESTNET">Arc Testnet</option><option value="ARC">Arc Mainnet</option></select></div><button id="provision-wallet" class="ghost">Create dedicated wallet</button>'
      : '') +
    '<span class="' + (gmailReady ? "done" : "") + '">✓ Business Gmail</span>' +
    '<span class="' + (policyReady ? "done" : "") + '">✓ Onchain payment policy</span>' +
    (walletReady && !policyReady
      ? '<button id="deploy-policy" class="ghost">' + (state.business?.policy_contract_status === "deploying" ? "Policy deployment running…" : "Deploy policy guard") + '</button>'
      : policyReady
        ? '<span class="setup-contract">Vault · ' + shortAddress(state.business.policy_contract_address) +
          (state.wallet?.policyVaultBalance != null ? " · " + Number(state.wallet.policyVaultBalance).toFixed(2) + " USDC" : "") +
          '</span>'
        : '') +
    '</div>';

  if (!walletReady) $("provision-wallet").addEventListener("click", provisionWallet);
  if (walletReady && !policyReady && state.business?.policy_contract_status !== "deploying") {
    $("deploy-policy").addEventListener("click", deployPolicy);
  }
}

async function provisionWallet() {
  const network = $("wallet-network")?.value || "ARC-TESTNET";
  if (network === "ARC") {
    const ok = window.confirm(
      "Create this business's dedicated Circle wallet on Arc Mainnet?\n\n" +
      "This creates the wallet only; no USDC is moved."
    );
    if (!ok) return;
  }

  const button = $("provision-wallet");
  button.disabled = true;
  button.textContent = "Creating wallet…";

  try {
    const response = await apiFetch("/api/wallet/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { network }
    });
    const data = await response.json();

    if (response.status === 409 && data.confirmation) {
      const confirmed = window.confirm(
        data.confirmation.purpose + "\n\nNetwork: " + data.confirmation.network
      );
      if (!confirmed) return;

      const retry = await apiFetch("/api/wallet/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, confirmMainnet: true })
      });
      const retryData = await retry.json();
      if (!retry.ok) throw new Error(retryData.error || "Wallet creation failed");
      state.business = retryData.business || state.business;
    } else if (!response.ok) {
      throw new Error(data.error || "Wallet creation failed");
    } else {
      state.business = data.business || state.business;
    }

    await loadPolicyStatus();
    const walletResponse = await apiFetch("/api/wallet");
    state.wallet = await walletResponse.json();
    renderAccount();
    renderSetup();
    toast("Dedicated business wallet ready");
  } catch (error) {
    toast(error.message);
    renderSetup();
  }
}

