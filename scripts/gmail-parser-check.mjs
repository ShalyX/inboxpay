import assert from "node:assert/strict";
import { parseInvoiceText } from "../lib/gmail-live.mjs";

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

console.log("Gmail invoice parser regression passed");
