import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  buildGmailInvoiceQueries,
  extractEmailAddress,
  extractHtmlText,
  parseInvoiceText,
} from "../lib/gmail-live.mjs";

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
assert.match(labelQuery.query, /label:InboxPay/);
assert.match(labelQuery.query, /after:1792022400/);

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
