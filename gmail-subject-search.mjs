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

async function req(route, params) {
  const r = await client.request({
    url: "https://gmail.googleapis.com/gmail/v1/users/me" + route,
    method: "GET",
    params
  });
  return r.data;
}

const queries = [
  "newer_than:365d subject:invoice",
  "newer_than:365d subject:(receipt)",
  "newer_than:365d subject:(bill)",
  "newer_than:365d \"payment due\""
];

for (const q of queries) {
  const list = await req("/messages", { q, maxResults: 20 });
  const rows = [];
  for (const item of list.messages || []) {
    const m = await req("/messages/" + item.id, {
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"]
    });
    const h = Object.fromEntries(
      (m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value])
    );
    rows.push({id:item.id,threadId:m.threadId,from:h.from||"",subject:h.subject||"",date:h.date||"",snippet:m.snippet||""});
  }
  console.log(JSON.stringify({query:q,count:rows.length,messages:rows}, null, 2));
}

