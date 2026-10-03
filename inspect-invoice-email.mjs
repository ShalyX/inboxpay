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

const messageId = process.argv[2] || "19f87fb9d4cb0f14";
const r = await client.request({
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + messageId,
  method: "GET",
  params: { format: "full" }
});

function decode(data) {
  return Buffer.from(
    String(data || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}
function headers(payload) {
  return Object.fromEntries(
    (payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );
}
function walk(part, out) {
  out = out || [];
  if (!part) return out;
  if (part.mimeType === "text/plain" || part.mimeType === "text/html") out.push(part);
  for (const child of part.parts || []) walk(child, out);
  return out;
}

const message = r.data;
const h = headers(message.payload);
const bodies = walk(message.payload).map(p => ({
  mimeType: p.mimeType,
  text: p.body?.data ? decode(p.body.data) : ""
}));

const output = {
  id: message.id,
  threadId: message.threadId,
  from: h.from || "",
  to: h.to || "",
  subject: h.subject || "",
  date: h.date || "",
  snippet: message.snippet || "",
  bodies
};
fs.writeFileSync(
  path.join(ROOT, "invoice-email-inspection.json"),
  JSON.stringify(output, null, 2) + "\n"
);
console.log(JSON.stringify(output, null, 2));

