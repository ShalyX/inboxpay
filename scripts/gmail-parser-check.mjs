import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { ensurePdfDomGlobals } from "../lib/pdf-runtime.mjs";
import {
  buildGmailMessageListParams,
  buildGmailInvoiceQueries,
  extractEmailAddress,
  extractHtmlText,
  findGmailLabelId,
  parseInvoiceText,
  scanGmailInvoices,
} from "../lib/gmail-live.mjs";

for (const name of ["DOMMatrix", "ImageData", "Path2D"]) delete globalThis[name];
await ensurePdfDomGlobals();
assert.equal(typeof globalThis.DOMMatrix, "function");
assert.equal(typeof globalThis.ImageData, "function");
assert.equal(typeof globalThis.Path2D, "function");

const parsed = parseInvoiceText(`Vendor: Manny
Invoice number: unique-test-001
Amount: 1.00 USDC
Due date: a future date
Payment recipient: 0x1DcB045123730e606A88380BCe534332F50332d2`, "sender@example.com");

assert.equal(parsed.vendor, "Manny");
assert.equal(parsed.invoiceNumber, "unique-test-001");
assert.equal(parsed.amount, 1);
assert.equal(parsed.currency, "USDC");
assert.equal(parsed.dueDate, "a future date");
assert.equal(parsed.extraction.confidence, "high");

const gmailRichTextAlternative = parseInvoiceText(`*Vendor:* Acme Test Hosting
*Invoice Number:* IP-LABEL-HTML-20261015-01
*Total Due:* 0.12 USDC
*Due Date:* October 31, 2026
*Currency:* USDC`, "shallomalabi89@gmail.com");
assert.equal(gmailRichTextAlternative.vendor, "Acme Test Hosting");
assert.equal(gmailRichTextAlternative.invoiceNumber, "IP-LABEL-HTML-20261015-01");
assert.equal(gmailRichTextAlternative.amount, 0.12);
assert.equal(gmailRichTextAlternative.currency, "USDC");
assert.equal(gmailRichTextAlternative.dueDate, "October 31, 2026");
assert.equal(gmailRichTextAlternative.extraction.confidence, "high");

assert.equal(
  extractEmailAddress('"Acme Billing" <Billing@Acme.example>'),
  "billing@acme.example",
);

assert.match(
  extractHtmlText(`
    <html><body>
      <h1>Invoice INV-HTML-1</h1>
      <p>Amount due: <strong>25.00 USDC</strong></p>
      <p>Due date: October 20, 2026</p>
    </body></html>
  `),
  /Invoice INV-HTML-1[\s\S]*Amount due: 25\.00 USDC[\s\S]*Due date: October 20, 2026/,
);

const discoveryQueries = buildGmailInvoiceQueries({
  verifiedVendorEmails: ["billing@acme.example", "BILLING@ACME.EXAMPLE", "ap@vendor.test"],
  label: "InboxPay",
  broadenedAfter: "2026-10-15T00:00:00.000Z",
});

assert.equal(discoveryQueries[0].route, "keyword");
assert.match(discoveryQueries[0].query, /subject:invoice/);

const labelQuery = discoveryQueries.find(({ route }) => route === "label");
assert.ok(labelQuery);
assert.equal(labelQuery.label, "InboxPay");
assert.doesNotMatch(labelQuery.query, /label:/);
assert.equal(labelQuery.query, "in:anywhere");
assert.equal(labelQuery.afterMs, Date.parse("2026-10-15T00:00:00.000Z"));

assert.equal(
  findGmailLabelId([
    { id: "INBOX", name: "INBOX" },
    { id: "Label_42", name: "InboxPay" },
  ], "inboxpay"),
  "Label_42",
  "custom Gmail labels must resolve case-insensitively to their stable label ID",
);
assert.equal(findGmailLabelId([{ id: "Label_42", name: "Other" }], "InboxPay"), null);

assert.deepEqual(
  buildGmailMessageListParams(labelQuery, { labelId: "Label_42" }),
  {
    maxResults: 25,
    labelIds: "Label_42",
  },
  "label discovery must use Gmail's stable labelIds filter and enforce its watermark after retrieval",
);
assert.equal(
  buildGmailMessageListParams(labelQuery),
  null,
  "label discovery must fail closed when the configured custom label cannot be resolved",
);

const originalFetch = globalThis.fetch;
const observedMessageListParams = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const json = (body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    async json() { return body; },
  });
  if (url.pathname.endsWith("/labels")) {
    return json({ labels: [{ id: "Label_42", name: "InboxPay" }] });
  }
  if (url.pathname.endsWith("/messages")) {
    observedMessageListParams.push(Object.fromEntries(url.searchParams));
    return json(url.searchParams.get("labelIds") === "Label_42"
      ? { messages: [{ id: "label-message" }, { id: "old-label-message" }, { id: "sent-label-message" }] }
      : { messages: [{ id: "sent-keyword-message" }] });
  }
  if (
    url.pathname.endsWith("/messages/label-message") ||
    url.pathname.endsWith("/messages/old-label-message") ||
    url.pathname.endsWith("/messages/sent-label-message") ||
    url.pathname.endsWith("/messages/sent-keyword-message")
  ) {
    const oldMessage = url.pathname.endsWith("/messages/old-label-message");
    const sentMessage = url.pathname.includes("/messages/sent-");
    const sentKeywordMessage = url.pathname.endsWith("/messages/sent-keyword-message");
    const html = `<p>Vendor: Acme Test Hosting</p>
      <p>Invoice Number: IP-LABEL-HTML-1</p>
      <p>Total Due: 0.12 USDC</p>
      <p>Due Date: October 31, 2026</p>`;
    return json({
      id: oldMessage ? "old-label-message" : sentKeywordMessage ? "sent-keyword-message" : sentMessage ? "sent-label-message" : "label-message",
      threadId: oldMessage ? "old-label-thread" : sentKeywordMessage ? "sent-keyword-thread" : sentMessage ? "sent-label-thread" : "label-thread",
      internalDate: String(Date.parse(oldMessage ? "2026-10-14T23:59:59.000Z" : "2026-10-16T09:21:00.000Z")),
      labelIds: sentMessage ? ["SENT", "Label_42"] : ["INBOX", "Label_42"],
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "Shallom <shallomalabi89@gmail.com>" },
          { name: "Subject", value: "October hosting notice" },
          { name: "Date", value: "Fri, 16 Oct 2026 09:21:00 +0000" },
          { name: "Message-ID", value: "<label-message@example.test>" },
        ],
        body: { data: Buffer.from(html).toString("base64url") },
      },
    });
  }
  throw new Error(`Unexpected Gmail test request: ${url}`);
};
try {
  const labelScan = await scanGmailInvoices("test-token", {
    label: "InboxPay",
    broadenedAfter: "2026-10-15T00:00:00.000Z",
  });
  assert.equal(labelScan.count, 1);
  assert.equal(labelScan.labelResolved, true);
  assert.equal(labelScan.routeMessageCounts.label, 3);
  assert.equal(
    labelScan.invoices.some((invoice) => invoice.messageId === "sent-label-message" || invoice.messageId === "sent-keyword-message"),
    false,
    "outbound Gmail messages must never enter invoice ingestion through keyword or explicit-label discovery",
  );
  assert.deepEqual(labelScan.invoices[0].discoveryRoutes, ["label"]);
  assert.equal(labelScan.invoices[0].invoiceNumber, "IP-LABEL-HTML-1");
  assert.equal(labelScan.invoices[0].amount, 0.12);
  assert.ok(observedMessageListParams.some((params) => params.labelIds === "Label_42"));
} finally {
  globalThis.fetch = originalFetch;
}

const vendorPdfQuery = discoveryQueries.find(({ route }) => route === "verified_vendor_pdf");
assert.ok(vendorPdfQuery);
assert.match(vendorPdfQuery.query, /has:attachment/);
assert.match(vendorPdfQuery.query, /filename:pdf/);
assert.match(vendorPdfQuery.query, /from:\(billing@acme\.example OR ap@vendor\.test\)/);
assert.doesNotMatch(vendorPdfQuery.query, /unknown@vendor\.test/);
assert.match(vendorPdfQuery.query, /after:1792022400/);

const unboundedQueries = buildGmailInvoiceQueries({
  verifiedVendorEmails: ["billing@acme.example"],
  label: "InboxPay",
});
assert.deepEqual(
  unboundedQueries.map(({ route }) => route),
  ["keyword"],
  "broadened discovery must fail closed without a durable start watermark",
);

const discoveryMigration = await fs.readFile(
  new URL("../supabase/migrations/20261015_vendor_aware_invoice_discovery.sql", import.meta.url),
  "utf8",
);
assert.match(discoveryMigration, /invoice_sender_emails text\[\]/i);
assert.match(discoveryMigration, /invoice_discovery_started_at timestamptz/i);
assert.match(discoveryMigration, /set invoice_discovery_started_at = now\(\)/i);
assert.match(discoveryMigration, /audit_events_ingestion_review_fingerprint_key/i);
assert.match(discoveryMigration, /create or replace function public\.update_vendor_invoice_senders/i);
assert.match(discoveryMigration, /security invoker\s+set search_path = ''/i);
assert.match(discoveryMigration, /for update of v/i);
assert.match(discoveryMigration, /vendor_invoice_senders_updated/i);

console.log("Gmail invoice parser regression passed");
