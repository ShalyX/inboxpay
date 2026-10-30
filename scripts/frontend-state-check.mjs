import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createDialog } from "../public/dialog.js";
import {
  activateDestination,
  auditEventCategory,
  auditEventLabel,
  destinationFromHash,
  inboxFailurePresentation,
  invoiceQueueCategory,
  invoiceDisplayState,
  networkLabel,
  paymentFlowStep,
  singleFlight
} from "../public/ui-state.mjs";
import { businessNameNeedsReview } from "../public/ui-state.mjs";

assert.equal(businessNameNeedsReview({ name: "gmail.com" }, "person@gmail.com"), true);
assert.equal(businessNameNeedsReview({ name: "My Business" }, "person@example.com"), true);
assert.equal(businessNameNeedsReview({ name: "Caraxes Labs", wallet_id: "wallet-a" }, "person@gmail.com"), false);
assert.equal(businessNameNeedsReview({ name: "gmail.com", network_accounts: [{ wallet_address: "0x123" }] }, "person@gmail.com"), false, "never interrupt an established business with legacy-name inference");
assert.equal(businessNameNeedsReview({ name: "North Studio" }, "person@gmail.com"), false);

assert.equal(destinationFromHash("#payments"), "payments");
assert.equal(destinationFromHash("#/vendors"), "vendors");
assert.equal(destinationFromHash("#unknown"), "inbox");
assert.equal(destinationFromHash("#operations"), "inbox", "Operator screens must not be reachable from the business workspace");
assert.equal(destinationFromHash("#notifications"), "notifications");
assert.equal(destinationFromHash("#setup"), "setup", "guided setup has a stable workspace destination");
assert.equal(destinationFromHash(""), "inbox");
assert.equal(auditEventLabel("payment_settled"), "Payment settled and reconciled");
assert.equal(auditEventLabel("custom_business_event"), "Custom business event");
assert.equal(auditEventCategory("payment_submitted"), "payments");
assert.equal(auditEventCategory("policy_allowance_approved"), "policy");
assert.equal(auditEventCategory("vendor_registered"), "vendors");
assert.equal(auditEventCategory("invoice_schedule_rescheduled"), "schedule");
assert.equal(auditEventLabel("payment_autonomy_enabled"), "Bounded payment autonomy enabled");
assert.equal(auditEventLabel("invoice_ingestion_review_required"), "Invoice attachment needs extraction review");
assert.equal(auditEventCategory("invoice_autonomy_completed"), "payments");
assert.equal(auditEventCategory("wallet_withdrawal_confirmed"), "payments");

function fakeElement(nav) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: nav ? { nav } : {},
    hidden: true,
    inert: false,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, active) => active ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name)
  };
}

const activitySection = fakeElement();
const sections = {
  inbox: null,
  payments: activitySection,
  policy: fakeElement(),
  audit: activitySection,
  business: fakeElement(),
  vendors: fakeElement(),
  notifications: fakeElement()
};
const navItems = Object.keys(sections).map(fakeElement);
const inboxContent = fakeElement();
for (const destination of Object.keys(sections)) {
  activateDestination(destination, sections, navItems, inboxContent);
  assert.deepEqual(
    [...new Set(Object.values(sections))].filter((section) => section && !section.hidden),
    sections[destination] ? [sections[destination]] : [],
    `${destination} must be the only visible destination`
  );
  assert.equal(inboxContent.inert, destination !== "inbox");
  assert.deepEqual(navItems.filter((item) => item.classList.contains("active")).map((item) => item.dataset.nav), [destination]);
  assert.deepEqual(navItems.filter((item) => item.getAttribute("aria-current") === "page").map((item) => item.dataset.nav), [destination]);
}
assert.throws(() => activateDestination("missing", sections, navItems), /Unknown workspace destination/);

assert.equal(networkLabel("ARC"), "Arc Mainnet");
assert.equal(networkLabel("ARC-TESTNET"), "Arc Testnet");
assert.equal(networkLabel("UNKNOWN"), "Arc");

assert.equal(paymentFlowStep({}), 0);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" } }), 1);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflightLoading: true }), 2);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1" }, preflight: { eligible: true } }), 3);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "processing" } } }), 4);
assert.equal(paymentFlowStep({ selected: { invoiceNumber: "INV-1", settlement: { status: "confirmed" } } }), 4);

assert.equal(invoiceQueueCategory({ settlement: { status: "confirmed" } }, false), "settled");
assert.equal(invoiceQueueCategory({ settlement: { reconciled: true } }, false), "settled");
assert.equal(invoiceQueueCategory({ invoiceNumber: "INV-1" }, true), "ready");
assert.equal(invoiceQueueCategory({ invoiceNumber: "INV-1" }, false), "review");

assert.equal(invoiceDisplayState({ settlement: { status: "confirmed" } }), "CONFIRMED", "confirmation alone must not claim reconciliation");
assert.equal(invoiceDisplayState({ settlement: { status: "confirmed", reconciled: true } }), "RECONCILED");
assert.equal(invoiceDisplayState({ settlement: { onchainDuplicate: true } }), "CONFIRMED", "duplicate evidence does not imply a matched record");
assert.equal(invoiceDisplayState({ settlement: { status: "processing" } }), "PENDING");
assert.equal(invoiceDisplayState({ settlement: { status: "failed" } }), "FAILED");
assert.equal(invoiceDisplayState({ settlement: { status: "confirmed" } }, { checking: true }), "CHECKING", "fresh preflight takes priority over saved labels");
assert.equal(invoiceDisplayState({ agentDecision: "PAY_NOW" }), "PAY_NOW");

const configFailure = inboxFailurePresentation("INBOXPAY_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key");
assert.equal(configFailure.kind, "service");
assert.equal(configFailure.title, "Live inbox temporarily unavailable");
assert.doesNotMatch(configFailure.message, /INBOXPAY_TOKEN_ENCRYPTION_KEY|32-byte|hex key/i);
assert.equal(configFailure.actionLabel, "Retry inbox evaluation");

const revoked = inboxFailurePresentation("invalid_grant: Token has been expired or revoked");
assert.equal(revoked.kind, "reauthorization");
assert.equal(revoked.title, "Reconnect your business inbox");
assert.equal(revoked.actionLabel, "Reconnect Gmail");

const ordinaryFailure = inboxFailurePresentation("Gmail request timed out");
assert.equal(ordinaryFailure.kind, "service");
assert.equal(ordinaryFailure.title, "Live inbox temporarily unavailable");
assert.doesNotMatch(ordinaryFailure.message, /timed out/i);

let releaseConnection;
let connectionStarts = 0;
const connectOnce = singleFlight(() => {
  connectionStarts += 1;
  return new Promise((resolve) => {
    releaseConnection = resolve;
  });
});
const firstConnection = connectOnce();
const repeatedConnection = connectOnce();
assert.strictEqual(repeatedConnection, firstConnection);
assert.equal(connectionStarts, 1);
releaseConnection();
await firstConnection;
const nextConnection = connectOnce();
assert.equal(connectionStarts, 2);
releaseConnection();
await nextConnection;

const [indexHtml, styles, activitySource] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../api/activity.mjs", import.meta.url), "utf8")
]);
assert.match(indexHtml, /id="skip-link"\s+class="skip-link"\s+href="#main-content"\s+hidden/);
assert.match(indexHtml, /id="main-content"\s+class="content"\s+tabindex="-1"/);
assert.match(indexHtml, /data-nav="notifications"/);
assert.match(indexHtml, /id="notifications-modal"/);
assert.doesNotMatch(indexHtml, /data-nav="operations"|id="open-operations"|notify-service-attention|notify-service-recovered/);
assert.doesNotMatch(activitySource, /view === "operations"|probeBusinessOperations|operations_service_states/);
assert.match(styles, /@media\(max-width:1180px\) and \(min-width:801px\)[\s\S]*?\.nav-groups nav\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
assert.match(styles, /@media\(max-width:1180px\) and \(min-width:801px\)[\s\S]*?\.workspace\{grid-template-columns:minmax\(0,1fr\)\}/);
assert.match(styles, /@media\(max-width:800px\)[\s\S]*?\.shell,\.sidebar,\.content\{min-width:0;width:100%;max-width:100%\}/);
assert.match(styles, /@media\(max-width:800px\)[\s\S]*?\.workspace>\.queue,\.workspace>\.detail,\.workspace>\.execution-rail\{grid-column:auto;grid-row:auto\}/);

assert.match(indexHtml, /<dialog\s+id="invoice-drawer"[^>]+aria-labelledby="invoice-drawer-title"/);
assert.match(indexHtml, /id="close-invoice"[^>]+aria-label="Close invoice details"/);
assert.match(indexHtml, /<dialog\s+id="auth-dialog"/);
assert.match(indexHtml, /Illustrative example/);
assert.match(indexHtml, /<video[^>]+controls[^>]+preload="none"/);
assert.doesNotMatch(indexHtml, /<video[^>]+autoplay/);
assert.match(indexHtml, /Illustrative studio scenes, not customer endorsements/);
assert.doesNotMatch(indexHtml, /BOUNDED PAYMENT OPERATIONS|THE CONTROL LAYER/);
const allIds = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(allIds).size, allIds.length, "frontend IDs must be unique");

// Lifecycle checks supplement the native-browser focus/Escape verification.
const handlers = new Map();
let focused = "";
const originalOpener = { isConnected: true, focus: () => { focused = "original"; } };
const replacementOpener = { focus: () => { focused = "replacement"; } };
const fakeDialog = {
  open: false,
  ownerDocument: { body: { style: { overflow: "auto" } }, activeElement: originalOpener },
  addEventListener: (name, handler) => handlers.set(name, handler),
  showModal() { this.open = true; },
  close() { this.open = false; handlers.get("close")(); },
  getBoundingClientRect: () => ({ left: 500, right: 1000, top: 0, bottom: 800 })
};
const drawer = createDialog(fakeDialog, { resolveOpener: () => replacementOpener });
fakeDialog.scrollTop = 480;
drawer.open(originalOpener);
assert.equal(fakeDialog.scrollTop, 0, "reopened drawer starts at its invoice heading");
assert.equal(drawer.isOpen, true);
assert.equal(fakeDialog.ownerDocument.body.style.overflow, "hidden");
drawer.open(originalOpener); // repeated opens must not overwrite the previous scroll mode
handlers.get("click")({ target: fakeDialog, clientX: 700, clientY: 300 });
assert.equal(drawer.isOpen, true, "clicking inside dialog must not dismiss it");
drawer.close();
assert.equal(focused, "original");
assert.equal(fakeDialog.ownerDocument.body.style.overflow, "auto");
drawer.open(originalOpener);
originalOpener.isConnected = false; // row replaced by a live preflight render
handlers.get("click")({ target: fakeDialog, clientX: 400, clientY: 300 });
assert.equal(drawer.isOpen, false);
assert.equal(focused, "replacement");
assert.equal(fakeDialog.ownerDocument.body.style.overflow, "auto");
drawer.close();

// A desktop invoice sheet is nonmodal: queue navigation and body scrolling stay available.
fakeDialog.show = function () { this.open = true; };
const desktopSheet = createDialog(fakeDialog, { modal: () => false });
desktopSheet.open(replacementOpener);
assert.equal(desktopSheet.isOpen, true);
assert.equal(desktopSheet.isModal, false);
assert.equal(fakeDialog.ownerDocument.body.style.overflow, "auto");
desktopSheet.close();
assert.equal(fakeDialog.ownerDocument.body.style.overflow, "auto");

const mediaSource = await readFile(new URL("../public/landing-media.js", import.meta.url), "utf8");
const filmEvents = new Map();
const sourceEvents = new Map();
const imageEvents = new Map();
const documentEvents = new Map();
const posterFallback = { hidden: true };
const unavailableNotice = { hidden: true };
const photoFallback = { hidden: true };
let intersectionCallback;
let pauseCount = 0;
const film = {
  paused: false, hidden: false,
  pause() { this.paused = true; pauseCount += 1; },
  addEventListener: (event, handler) => filmEvents.set(event, handler),
  querySelector: () => ({ addEventListener: (event, handler) => sourceEvents.set(event, handler) }),
  parentElement: { querySelector: (selector) => selector === ".film-poster-fallback" ? posterFallback : unavailableNotice }
};
const photo = {
  complete: true, naturalWidth: 1400, hidden: false,
  addEventListener: (event, handler) => imageEvents.set(event, handler),
  parentElement: { querySelector: () => photoFallback }
};
const mediaDocument = {
  hidden: false,
  getElementById: () => film,
  querySelectorAll: () => [photo],
  addEventListener: (event, handler) => documentEvents.set(event, handler)
};
runInNewContext(mediaSource, {
  document: mediaDocument,
  IntersectionObserver: class { constructor(handler) { intersectionCallback = handler; } observe() {} }
});
intersectionCallback([{ isIntersecting: false }]);
assert.equal(pauseCount, 1, "offscreen film pauses");
film.paused = false;
mediaDocument.hidden = true;
documentEvents.get("visibilitychange")();
assert.equal(pauseCount, 2, "background-tab film pauses");
sourceEvents.get("error")();
assert.equal(film.hidden, true);
assert.equal(posterFallback.hidden, false);
assert.equal(unavailableNotice.hidden, false);
imageEvents.get("error")();
assert.equal(photo.hidden, true);
assert.equal(photoFallback.hidden, false);
assert.ok((await readFile(new URL("../public/media/studio-film.mp4", import.meta.url))).length < 3_000_000, "landing film stays below its 3 MB budget");

// Exercise real render functions: unavailable data must not look disconnected/empty.
const appSource = await readFile(new URL("../public/inboxpay.js", import.meta.url), "utf8");
// Exercise the real Gmail handlers: disclosure, cancellation and late responses.
const gmailNodes = new Map();
const gmailNode = (id) => {
  if (!gmailNodes.has(id)) gmailNodes.set(id, {
    textContent: "", disabled: false, events: new Map(),
    addEventListener(event, handler) { this.events.set(event, handler); }
  });
  return gmailNodes.get(id);
};
const gmailState = {
  session: { user: { id: "owner-a" } },
  business: { id: "business-a", name: "Example Studio" }, gmail: null
};
const gmailUi = {
  isOpen: false,
  open(trigger) { this.isOpen = true; this.trigger = trigger; },
  close() { this.isOpen = false; gmailNode("gmail-dialog").events.get("close")(); }
};
let gmailStarts = 0;
let finishGmailStart;
let latestGmailSignal;
const gmailNavigations = [];
const gmailHandlersStart = appSource.indexOf("let gmailConnectionRequest = null;");
const gmailHandlersEnd = appSource.indexOf("async function disconnectGmail()", gmailHandlersStart);
assert.ok(gmailHandlersStart >= 0 && gmailHandlersEnd > gmailHandlersStart);
const gmailHandlers = runInNewContext(appSource.slice(gmailHandlersStart, gmailHandlersEnd) + "\n({ connectGmail, startGmailConnection })", {
  state: gmailState, $: gmailNode, gmailDialog: gmailUi, AbortController, URL,
  apiFetch: async (url, options) => {
    assert.equal(url, "/api/gmail/start");
    gmailStarts += 1;
    latestGmailSignal = options.signal;
    return new Promise((resolve) => { finishGmailStart = resolve; });
  },
  readJsonResponse: async (response) => response.body,
  window: { location: { assign: (url) => gmailNavigations.push(url) } }
});
const gmailOpener = { id: "empty-connect" };
gmailHandlers.connectGmail({ currentTarget: gmailOpener });
assert.equal(gmailUi.isOpen, true);
assert.equal(gmailUi.trigger, gmailOpener);
assert.equal(gmailNode("gmail-dialog-business").textContent, "Example Studio");
assert.equal(gmailStarts, 0, "reading the disclosure does not start authorization");
gmailNode("gmail-cancel").events.get("click")();
await gmailHandlers.startGmailConnection();
assert.equal(gmailStarts, 0, "closed disclosure cannot start authorization");
gmailHandlers.connectGmail();
const cancelledStart = gmailHandlers.startGmailConnection();
await gmailHandlers.startGmailConnection();
assert.equal(gmailStarts, 1, "repeated Continue clicks start one request");
assert.equal(gmailNode("gmail-continue").disabled, true);
gmailUi.close();
assert.equal(latestGmailSignal.aborted, true);
finishGmailStart({ ok: true, body: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic" } });
await cancelledStart;
assert.equal(gmailNavigations.length, 0, "late response cannot navigate after cancellation");
assert.equal(gmailNode("gmail-continue").disabled, false);
gmailHandlers.connectGmail();
const failedStart = gmailHandlers.startGmailConnection();
finishGmailStart({ ok: false, body: { error: "Connection temporarily unavailable" } });
await failedStart;
assert.equal(gmailNode("gmail-connection-message").textContent, "Connection temporarily unavailable");
assert.equal(gmailNode("gmail-continue").disabled, false, "failure allows explicit retry");
const retryStart = gmailHandlers.startGmailConnection();
finishGmailStart({ ok: true, body: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic" } });
await retryStart;
assert.equal(gmailNavigations.length, 1);
gmailNavigations.length = 0;
const changedBusinessStart = gmailHandlers.startGmailConnection();
gmailState.business = { id: "business-b", name: "Other business" };
finishGmailStart({ ok: true, body: { url: "https://accounts.google.com/o/oauth2/v2/auth" } });
await changedBusinessStart;
assert.equal(gmailNavigations.length, 0, "changed business cannot use an earlier response");
const unexpectedRedirect = gmailHandlers.startGmailConnection();
finishGmailStart({ ok: true, body: { url: "https://example.invalid/o/oauth2/v2/auth" } });
await unexpectedRedirect;
assert.equal(gmailNavigations.length, 0, "unexpected authorization hosts are rejected");
assert.match(gmailNode("gmail-connection-message").textContent, /could not be opened/);
gmailUi.close();
gmailState.gmail = { status: "reauthorization_required" };
gmailHandlers.connectGmail();
assert.equal(gmailNode("gmail-dialog-title").textContent, "Reconnect business Gmail");
gmailUi.close();
const startsBeforePreview = gmailStarts;
gmailState.previewReadOnly = true;
gmailHandlers.connectGmail();
assert.equal(gmailUi.isOpen, false, "read-only preview cannot open a connection flow");
await gmailHandlers.startGmailConnection();
assert.equal(gmailStarts, startsBeforePreview);

const qaNodes = new Map();
const qaNode = (id) => {
  if (!qaNodes.has(id)) qaNodes.set(id, { textContent: "", innerHTML: "", className: "", hidden: false });
  return qaNodes.get(id);
};
const qaState = { previewReadOnly: true, notification: null, vendorsError: "fetch failed", vendors: [] };
for (const name of ["renderNotifications", "renderVendors"]) {
  const start = appSource.indexOf("function " + name + "() {");
  const end = appSource.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start);
  runInNewContext(appSource.slice(start, end) + "\n" + name + "();", {
    state: qaState, $: qaNode, pageMetric: (...values) => values.join(" | ")
  });
}
assert.equal(qaNode("notification-status").textContent, "Not checked in preview");
assert.equal(qaNode("notification-connect").hidden, true);
assert.equal(qaNode("notification-refresh").hidden, true);
assert.equal(qaNode("vendor-count-label").textContent, "Unavailable");
assert.match(qaNode("vendor-list").innerHTML, /Vendor records unavailable/);
assert.doesNotMatch(qaNode("vendor-list").innerHTML, /No vendors registered/);
assert.match(appSource, /autonomy.status === "completed" \? "Execution completed/);
assert.match(appSource, /querySelectorAll\('[^']*\.verify-vendor, \.revoke-vendor/, "preview locks dynamically rendered vendor actions");
assert.match(indexHtml, /id="signed-in-email"/);
assert.match(indexHtml, /id="signed-in-email-mobile"/);
qaState.businessNameRequired = true;
qaState.business = null;
qaNodes.clear();
qaNode("business-identity-form").addEventListener = () => {};
const setupStart = appSource.indexOf("function renderSetup() {");
const setupEnd = appSource.indexOf("\n}", setupStart) + 2;
runInNewContext(appSource.slice(setupStart, setupEnd) + "\nrenderSetup();", {
  state: qaState, $: qaNode, businessNameNeedsReview, saveInitialBusinessName() {}
});
assert.match(qaNode("setup-card").innerHTML, /What’s your business called/);
assert.match(qaNode("setup-card").innerHTML, /autocomplete="organization"/);
assert.match(qaNode("setup-card").innerHTML, /Naming is disabled in this read-only preview/);
assert.doesNotMatch(qaNode("setup-card").innerHTML, /id="provision-wallet"/, "naming comes before wallet setup");
assert.match(appSource, /function renderBootstrapFailure\(/, "startup failure must not masquerade as an unconfigured business");
const failureStart = appSource.indexOf("function renderBootstrapFailure() {");
const failureEnd = appSource.indexOf("\n}", failureStart) + 2;
runInNewContext(appSource.slice(failureStart, failureEnd) + "\nrenderBootstrapFailure();", { $: qaNode });
assert.equal(qaNode("bootstrap-notice").hidden, false);
assert.equal(qaNode("setup-card").hidden, true);
assert.equal(qaNode("invoice-count").textContent, "—");
assert.equal(qaNode("queue-count").textContent, "Unavailable");
assert.match(qaNode("invoice-list").innerHTML, /not an empty-workspace result/);

// A preview never reads allowance: false must not become an authorization claim.
const policyStart = appSource.indexOf("function renderPolicyModal() {");
const policyEnd = appSource.indexOf("\n}", policyStart) + 2;
const policyNodes = new Map();
const policyNode = (id) => {
  if (!policyNodes.has(id)) policyNodes.set(id, { textContent: "", innerHTML: "", dataset: {}, hidden: false });
  return policyNodes.get(id);
};
const policyState = { previewReadOnly: true, business: { wallet_blockchain: "ARC-TESTNET", policy_contract_address: "0x1" }, policyConfig: {}, policyAllowance: false };
const renderPolicy = () => runInNewContext(appSource.slice(policyStart, policyEnd) + "\nrenderPolicyModal();", {
  state: policyState, $: policyNode, policyIsReady: () => true, policyAmount: String,
  document: { querySelectorAll: () => [] }, escapeHtml: String
});
renderPolicy();
assert.equal(policyNode("policy-allowance-title").textContent, "USDC access not checked in preview");
assert.doesNotMatch(policyNode("policy-allowance-note").textContent, /cannot move funds|not authorized/);
assert.equal(policyNode("policy-allowance").disabled, true);
assert.equal(policyNode("policy-allowance").dataset.authorized, "unknown");
policyState.previewReadOnly = false;
renderPolicy();
assert.equal(policyNode("policy-allowance-title").textContent, "USDC access not authorized");
policyState.policyAllowance = true;
renderPolicy();
assert.equal(policyNode("policy-allowance-title").textContent, "USDC access authorized");
assert.equal(policyNode("policy-allowance").disabled, false);
const correspondenceCss = await readFile(new URL("../public/correspondence.css", import.meta.url), "utf8");
assert.match(correspondenceCss, /\.access-card \.policy-secondary,[\s\S]*?\.access-card \.policy-allowance\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/, "access controls stack at every width, not just on phones");

console.log("frontend state, dialog lifecycle, and media checks passed");
