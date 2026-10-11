import { keccak256 } from "viem";

export function invoicePaymentId(invoice) {
  return keccak256(new TextEncoder().encode([
    "inboxpay:invoice",
    invoice.business_id || invoice.businessId || "",
    String(invoice.vendor || "").trim().toLowerCase(),
    String(invoice.invoice_number || invoice.invoiceNumber || "").trim().toLowerCase(),
    invoice.due_date || invoice.dueDate || ""
  ].join("|")));
}
