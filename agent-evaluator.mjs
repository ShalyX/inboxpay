import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vendorRegistry from "./vendor-registry.json" with { type: "json" };
import { evaluateInvoiceRecords } from "./lib/evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const scan = JSON.parse(fs.readFileSync(path.join(ROOT, "gmail-scan-result.json"), "utf8"));
const output = evaluateInvoiceRecords(scan.invoices || [], vendorRegistry);

fs.writeFileSync(
  path.join(ROOT, "agent-decisions.json"),
  JSON.stringify(output, null, 2) + "\n"
);
console.log(JSON.stringify(output, null, 2));
