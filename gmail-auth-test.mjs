import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";

const root = path.dirname(fileURLToPath(import.meta.url));
const credentialsPath = path.join(root, "credentials.json");
const auth = await authenticate({
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
  ],
  keyfilePath: credentialsPath
});

console.log("oauth:authenticated");
const response = await auth.request({
  url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  method: "GET"
});
console.log(JSON.stringify({
  gmailApi: "reachable",
  emailAddress: response.data.emailAddress,
  messagesTotal: response.data.messagesTotal
}, null, 2));

