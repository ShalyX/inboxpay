// Workspace composition only. Financial actions remain in inboxpay.js.
const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const make = (tag, className, html = "") => { const node = document.createElement(tag); node.className = className; node.innerHTML = html; return node; };
const pages = ["vendor-modal", "policy-modal", "activity-modal", "business-modal", "notifications-modal"];
const settings = new Set(["business", "policy", "audit", "notifications"]);

export function mountWorkspace() {
  const shell = $("app-shell");
  const content = $("main-content");
  const sidebar = shell.querySelector(".sidebar");
  const brand = sidebar.querySelector(".brand");
  const business = sidebar.querySelector(".workspace-business");
  const email = $("signed-in-email");
  const rail = sidebar.querySelector(".rail-state");
  const connectButton = $("connect-gmail");
  const refreshButton = $("refresh");
  const feed = document.querySelector(".gmail-context .feed-card");
  const legacyActions = document.querySelector(".action-cluster");
  const primary = make("nav", "daily-nav"); primary.setAttribute("aria-label", "Main navigation");
  const settingsTabs = make("nav", "settings-tabs"); settingsTabs.setAttribute("aria-label", "Settings sections"); settingsTabs.hidden = true;
  const profileTab = make("button", "nav", "Business details"); profileTab.type = "button"; profileTab.id = "settings-profile"; profileTab.dataset.nav = "business";
  settingsTabs.append(profileTab, $("open-policy"), $("nav-notifications"), $("open-audit"));
  const setupButton = make("button", "nav", '<span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2"/></svg></span><span>Setup</span>');
  setupButton.id = "nav-setup"; setupButton.type = "button"; setupButton.dataset.nav = "setup";
  $("nav-business").querySelector(".nav-icon + span").textContent = "Settings";
  primary.append(shell.querySelector('[data-nav="inbox"]'), $("open-payments"), $("nav-vendors"), setupButton, $("nav-business"));
  const bottom = make("div", "sidebar-bottom", '<div class="setup-nudge"><span>MAKE IT YOURS</span><strong>A little setup.<br>A lighter workday.</strong><p>Keep your inbox and payment preferences in order.</p><button id="sidebar-setup" type="button">Review setup <span aria-hidden="true">↗</span></button></div><button id="workspace-profile" class="workspace-profile" type="button"><span class="profile-avatar" aria-hidden="true">↳</span><span class="profile-copy"><b>Your account</b></span><span aria-hidden="true">⚙</span></button>');
  bottom.querySelector(".profile-copy").append(email);
  sidebar.replaceChildren(brand, business, make("div", "daily-nav-label", "WORKSPACE"), primary, bottom);

  const inbox = make("div", "inbox-view"); inbox.id = "inbox-view";
  while (content.firstChild) inbox.append(content.firstChild);
  content.append(inbox);
  const outer = make("div", "daily-main");
  content.before(outer);
  const bar = make("header", "daily-topbar", '<div class="workspace-crumb">Workspace <span>/</span> <b id="workspace-crumb">Invoices</b></div><div class="workspace-utilities"></div>');
  const utility = bar.querySelector(".workspace-utilities");
  const fixtureNotice = [...document.body.children].find((node) => node.tagName === "DIV" && node.textContent.trim() === "LOCAL UI FIXTURE · NO REAL DATA OR PAYMENTS");
  if (fixtureNotice) {
    fixtureNotice.removeAttribute("style");
    fixtureNotice.className = "local-review-label";
    fixtureNotice.textContent = "Sample workspace";
    fixtureNotice.title = "Local UI fixture. No real data or payments.";
    utility.append(fixtureNotice);
    bar.querySelector(".workspace-crumb").firstChild.textContent = "Sample ";
  }
  const network = inbox.querySelector(".environment-control"); utility.append(network);
  const account = $("workspace-controls");
  const networkLabel = $("workspace-controls-network"); networkLabel.className = "visually-hidden";
  account.className = "account-popover"; account.open = false;
  account.querySelector("summary").replaceChildren(document.createTextNode("Account ⌄"), networkLabel);
  const businessContext = account.querySelector(".business-context"); businessContext.open = true;
  const accountBody = make("div", "account-popover-body"); accountBody.append(businessContext, rail, $("sign-out"));
  account.querySelector(".account-actions").remove(); account.append(accountBody); utility.append(account);
  utility.append(make("a", "workspace-help", "?")); utility.lastChild.href = "/help.html"; utility.lastChild.setAttribute("aria-label", "Business help");
  const oldHeader = inbox.querySelector(".topbar");
  const copy = oldHeader.querySelector(".page-heading"); copy.className = "daily-page-copy";
  const head = make("header", "daily-page-head"); const actions = make("div", "page-actions");
  actions.append(connectButton, refreshButton); head.append(copy, actions);
  feed.className = "queue-sync";
  inbox.querySelector(".panel-head").append(feed);
  oldHeader.replaceWith(head);
  const slot = make("div", "inbox-setup-slot"); slot.id = "inbox-setup-slot"; $("setup-card").before(slot); slot.append($("setup-card"));
  const footer = inbox.querySelector(".app-footer");
  outer.append(bar, settingsTabs, content, footer);
  for (const id of pages) {
    const page = $(id); page.classList.remove("vendor-modal"); page.classList.add("workspace-page"); content.append(page);
    const body = page.firstElementChild; body.classList.remove("vendor-card"); body.classList.add("workspace-page-body");
    page.querySelectorAll(".detail-top.page-titlebar").forEach((node) => node.classList.remove("detail-top"));
    page.querySelectorAll(".destination-grid").forEach((node) => { node.classList.remove("destination-grid"); node.classList.add("settings-layout"); });
    page.querySelectorAll(".destination-card").forEach((node) => { node.classList.remove("destination-card"); node.classList.add("settings-group"); });
    page.querySelectorAll(".section-heading").forEach((node) => { node.classList.remove("section-heading"); node.classList.add("group-heading"); });
  }
  $("notifications-modal").querySelector(".page-titlebar p").textContent = "Choose where your business receives payment updates.";
  $("notifications-title").textContent = "Keep up with your payments.";
  $("notifications-modal").querySelector(".notification-status-card h3").textContent = "Telegram alerts";
  $("notifications-modal").querySelector(".notification-preferences-card h3").textContent = "What you’ll receive";
  $("notifications-modal").querySelector(".notification-preferences-card p").textContent = "Updates when a payment is submitted, confirmed, reconciled, fails, or needs review. Delivery can lag the recorded state; use Payments for the latest payment record.";
  $("business-title").textContent = "Business details.";
  $("vendor-modal").querySelector(".page-titlebar h2").textContent = "Know who you’re paying.";
  $("vendor-modal").querySelector(".page-titlebar p").textContent = "A single record for every vendor, invoice, and payment recipient.";
  const vendorActions = make("div", "page-actions"); const addVendor = make("button", "primary-button", '<span aria-hidden="true">＋</span> Add vendor'); addVendor.id = "new-vendor"; addVendor.type = "button";
  vendorActions.append(addVendor); $("vendor-modal").querySelector(".page-titlebar").append(vendorActions);
  const vendorDialog = make("dialog", "workspace-form-dialog", '<header><h2 id="vendor-entry-title">Add a vendor</h2><button id="close-vendor-entry" class="icon-button" type="button" aria-label="Close vendor form">×</button></header>');
  vendorDialog.id = "vendor-entry-dialog"; vendorDialog.setAttribute("aria-labelledby", "vendor-entry-title");
  vendorDialog.append($("vendor-modal").querySelector(".vendor-entry-card")); shell.append(vendorDialog);
  const vendorDirectory = $("vendor-modal").querySelector(".vendor-directory-card");
  const vendorSearch = make("label", "registry-search", '<span class="visually-hidden">Search vendors</span><input id="vendor-search" type="search" placeholder="Search vendor or email…" autocomplete="off">');
  vendorDirectory.querySelector(".group-heading").after(vendorSearch);
  vendorSearch.after(make("div", "registry-columns", '<span>Vendor</span><span>Billing contact</span><span>Recipient status</span><span>Next action</span>'));
  const setupPage = make("section", "workspace-page", '<header class="daily-page-head"><div class="daily-page-copy"><h1>A calmer invoice day starts here.</h1><p>Set up your business, inbox, and payment preferences.</p></div></header><div class="guide-layout"><nav class="guide-steps" aria-label="Setup steps" id="guide-steps"></nav><section class="guide-stage"><div id="guide-copy"></div><div id="guide-live-controls"></div><div id="guide-footer"></div></section></div>');
  setupPage.id = "setup-page"; setupPage.hidden = true; content.append(setupPage);
  const identity = shell.querySelector(".mobile-account-identity"); if (identity) identity.className = "visually-hidden";
  // Existing status/config nodes remain mounted for their original render functions.
  const backstage = make("div", "visually-hidden");
  if (legacyActions) backstage.append(legacyActions);
  shell.append(backstage);
}

export function paintWorkspaceNavigation(destination) {
  const labels = { inbox: "Invoices", payments: "Payments", vendors: "Vendors", setup: "Setup", business: "Business details", policy: "Payment settings", notifications: "Notifications", audit: "Activity" };
  $("workspace-crumb").textContent = labels[destination] || "Invoices";
  document.querySelector(".settings-tabs").hidden = !settings.has(destination);
  const rootSettings = $("nav-business"); rootSettings.classList.toggle("active", settings.has(destination));
  if (settings.has(destination)) rootSettings.setAttribute("aria-current", "page");
  else rootSettings.removeAttribute("aria-current");
  $("inbox-view").hidden = destination !== "inbox";
  const setupHost = destination === "setup" ? $("guide-live-controls") : $("inbox-setup-slot"); setupHost.append($("setup-card"));
  document.querySelector(".daily-main").dataset.destination = destination;
  const title = document.querySelector(".page-mode h2, .page-mode h1"); if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
}

export function renderSetupGuide(state, step, callbacks) {
  const named = Boolean(state.business && !state.businessNameRequired);
  const connected = state.gmail?.status === "connected";
  const wallet = state.business?.wallet_status === "ready";
  const policy = state.business?.policy_contract_status === "ready" && !state.policyStatusError;
  const steps = [["Business details", "Your workspace", named], ["Connect inbox", "Bring invoices together", connected], ["Business wallet", "Your payment account", wallet], ["Payment preferences", "Review before paying", policy]];
  $("guide-steps").innerHTML = steps.map(([title, subtitle, done], n) => '<button class="guide-step' + (n === step ? ' active' : '') + '" type="button" data-guide-step="' + n + '"' + (n === step ? ' aria-current="step"' : '') + '><span>' + (done ? '✓' : n + 1) + '</span><div>' + title + '<small>' + subtitle + '</small></div></button>').join("");
  const content = [
    ["Start with your business.", "Use the name that belongs on your workspace and payment records.", state.business?.name || "Business name needed", "Review business details", callbacks.business],
    ["One place for invoice email.", "Connect the Gmail inbox that receives invoices. Recorded email and PDF source information stays with each invoice.", connected ? "Gmail connected" : "Gmail not connected", connected ? "Manage inbox connection" : "Connect business Gmail", connected ? callbacks.business : callbacks.gmail],
    ["An account for business payments.", "Review the dedicated business wallet and the network it uses before you pay your first invoice.", wallet ? "Business wallet ready" : "Wallet setup needed", "Review business wallet", callbacks.business],
    ["Your payment preferences.", "Set payment limits and the balance to keep. Payment eligibility is still checked against the current business and network before each transfer.", policy ? "Payment settings configured" : "Payment settings need review", "Review payment preferences", callbacks.policy]
  ][step];
  const [title, copy, value, action, callback] = content;
  $("guide-copy").innerHTML = '<span class="guide-emblem" aria-hidden="true">' + ["↳", "✉", "≋", "✓"][step] + '</span><h2>' + title + '</h2><p>' + copy + '</p><div class="guide-state"><span>Current state</span><strong>' + escape(value) + '</strong></div>';
  const live = $("guide-live-controls"); live.hidden = !(state.businessNameRequired || step === 2 && !wallet || step === 3 && !policy);
  $("guide-footer").innerHTML = '<span>STEP ' + (step + 1) + ' OF 4</span><button id="guide-action" type="button" class="primary-button"' + (!named || state.bootstrapError || state.previewReadOnly && step === 1 && !connected ? ' disabled' : '') + '>' + action + ' <span aria-hidden="true">→</span></button>';
  $("guide-action").addEventListener("click", callback);
  $("guide-steps").querySelectorAll("[data-guide-step]").forEach((button) => button.addEventListener("click", () => callbacks.step(Number(button.dataset.guideStep))));
}
