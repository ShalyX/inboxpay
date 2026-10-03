import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const credentialsPath = path.join(ROOT, "credentials.json");
const tokenPath = path.join(ROOT, "gmail-token.json");
const keyFile = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
const keys = keyFile.installed || keyFile.web;
const OAuth2Client = (await import("google-auth-library")).OAuth2Client;
const client = new OAuth2Client(keys.client_id, keys.client_secret);
client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf8")));

async function req(route, params) {
  const r = await client.request({
    url: "https://gmail.googleapis.com/gmail/v1/users/me" + route,
    method: "GET",
    params
  });
  return r.data;
}

const profile = await req("/profile");
console.log("profile:", profile.emailAddress);

const list = await req("/messages", {
  q: "newer_than:180d {invoice receipt bill payment} -label:spam -label:trash",
  maxResults: 50
});
const messages = list.messages || [];
const rows = [];
for (const item of messages.slice(0, 25)) {
  const m = await req("/messages/" + encodeURIComponent(item.id), {
    format: "metadata",
    metadataHeaders: ["From", "To", "Subject", "Date"]
  });
  const h = Object.fromEntries(
    (m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value])
  );
  rows.push({
    id: item.id,
    threadId: m.threadId,
    from: h.from || "",
    subject: h.subject || "",
    date: h.date || "",
    snippet: m.snippet || ""
  });
}
console.log(JSON.stringify({count: rows.length, messages: rows}, null, 2));

