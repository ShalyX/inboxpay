import { PDFParse } from "pdf-parse";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function getHeader(message, name) {
  return message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBase64Url(data) {
  return Buffer.from(
    String(data || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
}

function walkParts(part, out = []) {
  if (!part) return out;
  out.push(part);
  for (const child of part.parts || []) walkParts(child, out);
  return out;
}

function extractPlainText(parts) {
  return parts
    .filter((part) =>
      part.mimeType === "text/plain" &&
      !part.filename &&
      !part.body?.attachmentId &&
      part.body?.data
    )
    .map((part) => decodeBase64Url(part.body.data).toString("utf8"))
    .join("\n")
    .trim();
}

function displayVendor(from) {
  const match = String(from || "").match(/^"?([^"<]+?)"?\s*<[^>]+>/);
  return match?.[1]?.trim() || null;
}

export function parseInvoiceText(text, fallbackVendor) {
  const clean = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n+/g, "\n");

  const invoiceNumber =
    clean.match(/\binvoice\s*(?:number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})/i)?.[1] || null;

  const amountMatch =
    clean.match(/\b(?:amount\s+due|total\s+due|balance\s+due)\s*[:\-]?\s*(?:US\$|\$)?\s*([0-9,]+(?:\.\d{2})?)/i) ||
    clean.match(/\b(?:total|balance)\s*[:\-]?\s*(?:US\$|\$)?\s*([0-9,]+(?:\.\d{2})?)\s*(?:USD)?/i);

  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : null;
  const dueDateText = clean.match(/due\s+date\s*[:\-]?\s*([A-Z0-9][A-Z0-9, ./-]{5,30})/i)?.[1]?.trim() || null;
  const dueDate = dueDateText ? dueDateText.replace(/(\d+)(st|nd|rd|th)/gi, "$1") : null;
  const currency = clean.match(/\b(USDC|USD|EUR|GBP)\b/i)?.[1].toUpperCase() || "USD";
  const vendorName = clean.match(/\bvendor\s*[:\-]\s*([^\n]+)/i)?.[1]?.trim() || null;
  const confidence = invoiceNumber && amount !== null && dueDate
    ? "high"
    : invoiceNumber && amount !== null
      ? "medium"
      : "low";

  return {
    vendor: vendorName || fallbackVendor || null,
    invoiceNumber,
    amount,
    currency,
    dueDate,
    extraction: {
      source: "gmail-live",
      parser: "deterministic-regex-v2",
      confidence
    }
  };
}

async function gmailRequest(token, route, params) {
  const url = new URL(GMAIL_BASE + route);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error("Gmail API " + response.status + ": " + (data.error?.message || response.statusText));
  }
  return data;
}

async function downloadAttachment(token, messageId, attachmentId) {
  const payload = await gmailRequest(
    token,
    "/messages/" + encodeURIComponent(messageId) + "/attachments/" + encodeURIComponent(attachmentId)
  );
  if (!payload?.data) throw new Error("Gmail attachment response contained no data");
  return decodeBase64Url(payload.data);
}

export function gmailLiveConfigured() {
  return false;
}

export async function refreshGmailAccessToken(refreshToken) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    throw new Error("Gmail OAuth is not configured");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error("Google OAuth refresh failed: " + (data.error_description || data.error || response.statusText));
  }
  return data;
}

export async function scanGmailInvoices(accessToken) {
  if (!accessToken) throw new Error("Missing Gmail access token");

  const token = accessToken;
  const query = 'in:anywhere newer_than:365d {subject:invoice subject:bill "amount due" "payment due"}';
  const list = await gmailRequest(token, "/messages", { q: query, maxResults: 25 });
  const results = [];

  for (const item of list.messages || []) {
    const message = await gmailRequest(token, "/messages/" + encodeURIComponent(item.id), { format: "full" });
    const parts = walkParts(message.payload);
    const from = getHeader(message, "From");
    const subject = getHeader(message, "Subject");
    const bodyText = extractPlainText(parts);
    const invoiceFields = parseInvoiceText(bodyText || message.snippet || "", displayVendor(from) || from);

    const looksLikeInvoice = /invoice|amount due|balance due|payment due|total due/i.test(subject + "\n" + bodyText);
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
          paymentScheduledExternally: /payment will be taken automatically|automatic(?:ally)? payment|auto(?:matic)?-?pay/i.test(bodyText)
        },
        ...invoiceFields
      });
    }

    for (const part of parts.filter((p) => p.mimeType === "application/pdf" || p.filename?.toLowerCase().endsWith(".pdf"))) {
      if (!part.body?.attachmentId) continue;
      try {
        const pdfBytes = await downloadAttachment(token, item.id, part.body.attachmentId);
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
          attachment: part.filename || "invoice.pdf",
          source: "gmail-pdf",
          extractionStatus: "parsed",
          ...parseInvoiceText(parsed.text, displayVendor(from) || from)
        });
      } catch (error) {
        results.push({
          messageId: item.id,
          threadId: message.threadId,
          messageRfcId: getHeader(message, "Message-ID"),
          from,
          subject,
          date: getHeader(message, "Date"),
          attachment: part.filename || "invoice.pdf",
          source: "gmail-pdf",
          extractionStatus: "needs_review",
          extractionError: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    query,
    count: results.length,
    invoices: results
  };
}
