import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const scan = JSON.parse(fs.readFileSync(path.join(ROOT, "gmail-scan-result.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor-registry.json"), "utf8"));

function key(invoice) {
  return [
    invoice.threadId || "",
    invoice.invoiceNumber || "",
    invoice.vendor || ""
  ].join("|").toLowerCase();
}

function choose(records) {
  return records
    .slice()
    .sort(function (a, b) {
      const score = function (x) {
        return (x.extraction?.confidence === "high" ? 3 : x.extraction?.confidence === "medium" ? 2 : 1)
          + (x.source === "gmail-pdf" ? 1 : 0)
          + (x.amount !== null ? 1 : 0)
          + (x.dueDate ? 1 : 0);
      };
      return score(b) - score(a);
    })[0];
}

function evaluate(invoice, records) {
  const reasons = [];
  const vendor = registry[invoice.vendor];
  const emailAmounts = records.map(x => x.amount).filter(x => x !== null);
  const uniqueAmounts = [...new Set(emailAmounts)];
  const emailDueDates = records.map(x => x.dueDate).filter(Boolean);
  const uniqueDueDates = [...new Set(emailDueDates)];
  const externalAutopay = records.some(x => x.bodySignals?.paymentScheduledExternally);

  if (!invoice.invoiceNumber || invoice.amount === null || !invoice.dueDate) {
    reasons.push("Required invoice fields are incomplete.");
    return { decision: "ESCALATE", reasons };
  }

  if (uniqueAmounts.length > 1) {
    reasons.push("Conflicting invoice amounts were extracted from Gmail sources.");
    return { decision: "ESCALATE", reasons, conflict: { amounts: uniqueAmounts } };
  }

  if (uniqueDueDates.length > 1) {
    reasons.push("Conflicting due dates were extracted from Gmail sources.");
    return { decision: "ESCALATE", reasons, conflict: { dueDates: uniqueDueDates } };
  }

  if (invoice.currency !== "USDC") {
    reasons.push("Settlement currency is " + invoice.currency + "; Arc payment rail requires USDC.");
    return { decision: "HOLD", reasons };
  }

  if (externalAutopay) {
    reasons.push("Vendor indicates an external automatic payment method is already scheduled.");
    return { decision: "HOLD", reasons };
  }

  if (!vendor || vendor.status !== "verified") {
    reasons.push("Vendor is not verified in the payment registry.");
    return { decision: "ESCALATE", reasons };
  }

  if (vendor.currency !== invoice.currency) {
    reasons.push("Vendor settlement currency does not match invoice currency.");
    return { decision: "ESCALATE", reasons };
  }

  const due = new Date(invoice.dueDate);
  const today = new Date();
  const dueKey = due.toISOString().slice(0, 10);
  const todayKey = today.toISOString().slice(0, 10);

  if (dueKey <= todayKey) {
    reasons.push("Invoice is due today or overdue and passed verification.");
    return { decision: "PAY_NOW", reasons };
  }

  reasons.push("Invoice is verified and due in the future.");
  return { decision: "SCHEDULE", reasons };
}

const groups = new Map();
for (const record of scan.invoices || []) {
  const k = key(record);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(record);
}

const evaluated = [];
for (const records of groups.values()) {
  const representative = choose(records);
  if (!representative.invoiceNumber || representative.amount === null) continue;
  const result = evaluate(representative, records);
  evaluated.push({
    ...representative,
    sourceCount: records.length,
    sources: [...new Set(records.map(x => x.source))],
    agentDecision: result.decision,
    decisionReasons: result.reasons,
    conflict: result.conflict || null
  });
}

const output = {
  evaluatedAt: new Date().toISOString(),
  count: evaluated.length,
  invoices: evaluated
};

fs.writeFileSync(
  path.join(ROOT, "agent-decisions.json"),
  JSON.stringify(output, null, 2) + "\n"
);
console.log(JSON.stringify(output, null, 2));

