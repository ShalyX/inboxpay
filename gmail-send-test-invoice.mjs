import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const credentialsPath = path.join(ROOT, "credentials.json");
const tokenPath = path.join(ROOT, "gmail-token.json");

const keyFile = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
const keys = keyFile.installed || keyFile.web;
const OAuth2Client = (await import("google-auth-library")).OAuth2Client;
const client = new OAuth2Client(keys.client_id, keys.client_secret);
client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf8")));

async function req(route, options) {
  const r = await client.request({
    url: "https://gmail.googleapis.com/gmail/v1/users/me" + route,
    method: options?.method || "GET",
    params: options?.params,
    data: options?.data,
    headers: options?.headers
  });
  return r.data;
}

function base64Url(text) {
  return Buffer.from(text)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const profile = await req("/profile");
const subject = "[TAMEION TEST] Invoice — Acme Test Hosting — TA-GMAIL-0001";
const body = [
  "This is a controlled Tameion AP Agent test invoice.",
  "",
  "Vendor: Acme Test Hosting",
  "Invoice Number: TA-GMAIL-0001",
  "Amount Due: 0.50 USDC",
  "Due Date: October 2, 2026",
  "Currency: USDC",
  "",
  "Recipient wallet is maintained in the agent's verified vendor registry.",
  "",
  "Please process through the Tameion AP Agent test workflow."
].join("\n");

const raw = [
  "To: " + profile.emailAddress,
  "Subject: " + subject,
  "Content-Type: text/plain; charset=UTF-8",
  "",
  body
].join("\r\n");

const sent = await req("/messages/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  data: { raw: base64Url(raw) }
});

console.log(JSON.stringify({
  step: "test-invoice-sent",
  email: profile.emailAddress,
  messageId: sent.id,
  threadId: sent.threadId,
  invoiceNumber: "TA-GMAIL-0001",
  amount: "0.50 USDC"
}, null, 2));

