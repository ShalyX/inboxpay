import assert from "node:assert/strict";
import { normalizeBusinessName } from "../lib/business-profile.mjs";

assert.equal(normalizeBusinessName("  Acme   Holdings  "), "Acme Holdings");
assert.equal(normalizeBusinessName("Lagos Café"), "Lagos Café");
assert.throws(() => normalizeBusinessName(""), /at least 2/);
assert.throws(() => normalizeBusinessName("x"), /at least 2/);
assert.throws(() => normalizeBusinessName("a".repeat(81)), /80 characters/);
assert.throws(() => normalizeBusinessName("Acme\nHoldings"), /control characters/);

console.log("business profile checks passed");

