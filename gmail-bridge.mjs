import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";
import { PDFParse } from "pdf-parse";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const INBOX_DIR = path.join(ROOT, "gmail-inbox");
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function ensureInbox() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

function getHeader(message, name) {
  return message.payload?.headers?.find(function (h) {
    return h.name.toLowerCase() === name.toLowerCase();
  })?.value || "";
}

const TOKEN_PATH = path.join(ROOT, "gmail-token.json");

async function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2) + "\n");
}

async function getAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      "Missing credentials.json. Create a Google OAuth Desktop App credential and place it in the project root."
    );
  }

  const keyFile = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const keys = keyFile.installed || keyFile.web;
  if (!keys?.client_id || !keys?.client_secret) {
    throw new Error("Invalid Google OAuth credentials.json");
  }

  const OAuth2Client = (await import("google-auth-library")).OAuth2Client;
  const client = new OAuth2Client(keys.client_id, keys.client_secret);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    client.setCredentials(token);
    client.on("tokens", async function (tokens) {
      await saveToken({ ...client.credentials, ...tokens });
    });
    try {
      await client.getAccessToken();
      return client;
    } catch {}
  }

  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  await saveToken(auth.credentials);
  return auth;
}

async function gmailRequest(auth, route, options) {
  const response = await auth.request({
    url: GMAIL_BASE + route,
    method: options?.method || "GET",
    params: options?.params,
    data: options?.data,
    headers: options?.headers,
    responseType: options?.responseType
  });
  return response.data;
}

function walkParts(part, out) {
  out = out || [];
  if (!part) return out;
  out.push(part);
  for (const child of part.parts || []) walkParts(child, out);
  return out;
}

function decodeBase64Url(data) {
  return Buffer.from(
    String(data || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
}
function parseInvoiceText(text, fallbackVendor) {
  const clean = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n+/g, "\n");

  const invoiceNumber =
    clean.match(
      /\binvoice\s*(?:number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})/i
    )?.[1] || null;

  const amountMatch =
    clean.match(
      /\b(?:amount\s+due|total\s+due|balance\s+due)\s*[:\-]?\s*(?:US\$|\$)?\s*([0-9,]+(?:\.\d{2})?)/i
    ) ||
    clean.match(
      /\b(?:total|balance)\s*[:\-]?\s*(?:US\$|\$)?\s*([0-9,]+(?:\.\d{2})?)\s*(?:USD)?/i
    );

  const amount = amountMatch
    ? Number(amountMatch[1].replace(/,/g, ""))
    : null;

  const dueDateText =
    clean.match(
      /due\s+date\s*[:\-]?\s*([A-Z0-9][A-Z0-9, ./-]{5,30})/i
    )?.[1]?.trim() || null;

  const dueDate = dueDateText
    ? dueDateText.replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    : null;

  const currency =
    clean.match(/\b(USDC|USD|EUR|GBP)\b/i)?.[1].toUpperCase() || "USD";

  const vendorName =
    clean.match(/\bvendor\s*[:\-]\s*([^\n]+)/i)?.[1]?.trim() || null;

  const confidence =
    invoiceNumber && amount !== null && dueDate ? "high"
      : invoiceNumber && amount !== null ? "medium"
      : "low";

  return {
    vendor: vendorName || fallbackVendor || null,
    invoiceNumber,
    amount,
    currency,
    dueDate,
    extraction: {
      source: "gmail-invoice-text",
      parser: "deterministic-regex-v2",
      confidence
    }
  };
}

async function downloadAttachment(auth, messageId, attachmentId) {
  const payload = await gmailRequest(
    auth,
    "/messages/" + encodeURIComponent(messageId) +
      "/attachments/" + encodeURIComponent(attachmentId)
  );
  if (!payload?.data) throw new Error("Gmail attachment response contained no data");
  return decodeBase64Url(payload.data);
}
function extractPlainText(parts) {
  return parts
    .filter(function (part) {
      return (
        part.mimeType === "text/plain" &&
        !part.filename &&
        !part.body?.attachmentId &&
        part.body?.data
      );
    })
    .map(function (part) {
      return decodeBase64Url(part.body.data);
    })
    .join("\n")
    .trim();
}

async function scan() {
  ensureInbox();
  const auth = await getAuth();

  const query =
    "in:anywhere newer_than:365d {subject:invoice subject:bill \"amount due\" \"payment due\"}";
  const list = await gmailRequest(auth, "/messages", {
    params: { q: query, maxResults: 25 }
  });

  const messages = list.messages || [];
  const results = [];

  for (const item of messages) {
    const message = await gmailRequest(
      auth,
      "/messages/" + encodeURIComponent(item.id),
      { params: { format: "full" } }
    );

    const parts = walkParts(message.payload);
    const from = getHeader(message, "From");
    const subject = getHeader(message, "Subject");
    const bodyText = extractPlainText(parts);
    const invoiceFields = parseInvoiceText(
      bodyText || message.snippet || "",
      from
    );

    const looksLikeInvoice =
      /invoice|amount due|balance due|payment due|total due/i.test(
        subject + "\n" + bodyText
      );

    if (looksLikeInvoice) {
      results.push({
        messageId: item.id,
        threadId: message.threadId,
        messageRfcId: getHeader(message, "Message-ID"),
        from,
        subject,
        date: getHeader(message, "Date"),
        source: "gmail-email",
        extractionStatus: "parsed",
        bodySignals: {
          paymentScheduledExternally:
            /payment will be taken automatically|automatic(?:ally)? payment|auto(?:matic)?-?pay/i.test(
              bodyText
            )
        },
        ...invoiceFields
      });
    }

    const pdfParts = parts.filter(function (part) {
      return (
        part.mimeType === "application/pdf" ||
        part.filename?.toLowerCase().endsWith(".pdf")
      );
    });

    for (const part of pdfParts) {
      if (!part.body?.attachmentId) continue;

      const filename = part.filename || "invoice.pdf";
      const safeName =
        item.id + "-" + filename.replace(/[^a-z0-9._-]/gi, "_");

      try {
        const pdfBytes = await downloadAttachment(
          auth,
          item.id,
          part.body.attachmentId
        );
        fs.writeFileSync(path.join(INBOX_DIR, safeName), pdfBytes);

        const parser = new PDFParse({ data: pdfBytes });
        const parsed = await parser.getText();
        await parser.destroy();

        results.push({
          messageId: item.id,
          threadId: message.threadId,
          messageRfcId: getHeader(message, "Message-ID"),
          from,
          subject,
          date: getHeader(message, "Date"),
          attachment: filename,
          source: "gmail-pdf",
          extractionStatus: "parsed",
          ...parseInvoiceText(parsed.text, from)
        });
      } catch (error) {
        results.push({
          messageId: item.id,
          threadId: message.threadId,
          messageRfcId: getHeader(message, "Message-ID"),
          from,
          subject,
          date: getHeader(message, "Date"),
          attachment: filename,
          source: "gmail-pdf",
          extractionStatus: "needs_review",
          extractionError:
            error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const output = {
    scannedAt: new Date().toISOString(),
    query,
    count: results.length,
    invoices: results
  };

  fs.writeFileSync(
    path.join(ROOT, "gmail-scan-result.json"),
    JSON.stringify(output, null, 2) + "\n"
  );
  console.log(JSON.stringify(output, null, 2));
}
function encodeHeader(value) {
  return String(value || "").replace(/[^\x00-\x7F]/g, "");
}

function base64Url(text) {
  return Buffer.from(text)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sendReceipt(options) {
  const auth = await getAuth();
  const subject =
    "Paid: " + options.invoiceNumber + " — " + options.amount + " USDC settled on Arc";

  const body = [
    "Payment confirmed.",
    "",
    "Invoice: " + options.invoiceNumber,
    "Amount: " + options.amount + " USDC",
    "Network: Arc Testnet",
    "Transaction: " + options.txHash,
    "Policy vault: " + options.vaultAddress,
    "",
    "This payment was approved by the Tameion AP Agent after invoice verification and policy checks."
  ].join("\n");

  const raw = [
    "To: " + encodeHeader(options.to),
    "Subject: " + encodeHeader(subject),
    options.replyToMessageId ? "In-Reply-To: " + options.replyToMessageId : "",
    options.replyToMessageId ? "References: " + options.replyToMessageId : "",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body
  ].filter(Boolean).join("\r\n");

  return gmailRequest(auth, "/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      threadId: options.threadId,
      raw: base64Url(raw)
    }
  });
}

const mode = process.argv[2] || "scan";
if (mode === "scan") {
  await scan();
} else {
  throw new Error("Usage: node gmail-bridge.mjs scan");
}
