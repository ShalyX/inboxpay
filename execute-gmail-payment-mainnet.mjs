import { settleInvoice } from "./lib/inboxpay.mjs";

const invoiceNumber = process.argv[2] || "TA-GMAIL-0001";

console.log(JSON.stringify({
  step: "mainnet-settlement",
  invoiceNumber,
  network: "Arc Mainnet"
}, null, 2));

const result = await settleInvoice(invoiceNumber);

console.log(JSON.stringify({
  status: "PAYMENT_COMPLETE",
  invoiceNumber,
  network: "Arc Mainnet",
  ...result
}, null, 2));
