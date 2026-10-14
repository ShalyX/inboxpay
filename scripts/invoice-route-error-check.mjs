import assert from "node:assert/strict";
import { classifyInvoiceRouteError } from "../lib/invoice-route-errors.mjs";

const revoked = classifyInvoiceRouteError(
  new Error("Google OAuth refresh failed: Token has been expired or revoked.")
);
assert.deepEqual(revoked, {
  status: 409,
  body: {
    error: "Gmail authorization must be renewed",
    code: "GMAIL_REAUTH_REQUIRED"
  },
  log: "warning"
});

const invalidGrant = classifyInvoiceRouteError(new Error("Google OAuth refresh failed: invalid_grant"));
assert.equal(invalidGrant.status, 409);
assert.equal(invalidGrant.body.code, "GMAIL_REAUTH_REQUIRED");

const unauthenticated = classifyInvoiceRouteError(new Error("Authentication required"));
assert.deepEqual(unauthenticated, {
  status: 401,
  body: { error: "Authentication required" },
  log: "none"
});

const internal = classifyInvoiceRouteError(
  new Error("INBOXPAY_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key")
);
assert.deepEqual(internal, {
  status: 500,
  body: { error: "Invoice data unavailable" },
  log: "error"
});

console.log("Invoice route error contract passed");
