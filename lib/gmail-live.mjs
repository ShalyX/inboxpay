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

function decodeHtmlEntity(entity) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  if (entity[0] === "#") {
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : "&" + entity + ";";
  }
  return named[entity.toLowerCase()] ?? "&" + entity + ";";
}

export function extractHtmlText(html) {
  return String(html || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/(?:address|article|blockquote|div|h[1-6]|li|p|section|table|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([#a-z0-9]+);/gi, (_match, entity) => decodeHtmlEntity(entity))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHtmlBody(parts) {
  return parts
    .filter((part) =>
      part.mimeType === "text/html" &&
      !part.filename &&
      !part.body?.attachmentId &&
      part.body?.data
    )
    .map((part) => extractHtmlText(decodeBase64Url(part.body.data).toString("utf8")))
    .join("\n")
    .trim();
}

export function extractEmailAddress(from) {
  const input = String(from || "").trim();
  const bracketed = input.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/i)?.[1];
  const bare = input.match(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  return String(bracketed || bare || "").trim().toLowerCase() || null;
}

export function normalizeVendorEmails(emails) {
  return [...new Set((emails || [])
    .map((email) => extractEmailAddress(email))
    .filter(Boolean))]
    .slice(0, 20);
}

export function findGmailLabelId(labels, label) {
  const target = String(label || "").trim().toLowerCase();
  if (!target) return null;
  return (labels || []).find((item) =>
    String(item?.name || "").trim().toLowerCase() === target
  )?.id || null;
}

export function buildGmailMessageListParams(plan, { labelId = null } = {}) {
  if (!plan?.query) return null;
  if (plan.route === "label" && !labelId) return null;
  if (plan.route === "label") {
    return { maxResults: 25, labelIds: labelId };
  }
  return {
    q: plan.query,
    maxResults: 25
  };
}

export function buildGmailInvoiceQueries({
  verifiedVendorEmails = [],
  label = "InboxPay",
  broadenedAfter = null
} = {}) {
  const queries = [{
    route: "keyword",
    query: 'in:anywhere newer_than:365d {subject:invoice subject:bill subject:payment "amount due" "payment due" "amount:" "total:" "balance:"}'
  }];

  const timestamp = Date.parse(String(broadenedAfter || ""));
  if (!Number.isFinite(timestamp)) return queries;

  const after = "after:" + Math.floor(timestamp / 1000);
  const safeLabel = String(label || "").trim().match(/^[A-Za-z0-9_-]{1,64}$/)?.[0];
  if (safeLabel) {
    queries.push({
      route: "label",
      label: safeLabel,
      query: "in:anywhere",
      afterMs: timestamp
    });
  }

  const emails = normalizeVendorEmails(verifiedVendorEmails);
  if (emails.length) {
    queries.push({
      route: "verified_vendor_pdf",
      query: `in:anywhere ${after} has:attachment filename:pdf from:(${emails.join(" OR ")})`
    });
  }

  return queries;
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
    clean.match(/\b(?:amount\s+due|total\s+due|balance\s+due|amount|total|balance)\s*[:\-]?\s*(?:US\$|\$)?\s*([0-9,]+(?:\.\d{2})?)/i);

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

export async function scanGmailInvoices(accessToken, options = {}) {
  if (!accessToken) throw new Error("Missing Gmail access token");

  const token = accessToken;
  const queries = buildGmailInvoiceQueries(options);
  const messageRoutes = new Map();
  const maxMessages = 50;
  const routeMessageCounts = {};
  const labelPlan = queries.find(({ route }) => route === "label");
  let labelId = null;
  if (labelPlan) {
    const labels = await gmailRequest(token, "/labels");
    labelId = findGmailLabelId(labels.labels, labelPlan.label);
  }
  for (const plan of queries) {
    const params = buildGmailMessageListParams(plan, { labelId });
    if (!params) {
      routeMessageCounts[plan.route] = 0;
      continue;
    }
    const list = await gmailRequest(token, "/messages", params);
    routeMessageCounts[plan.route] = (list.messages || []).length;
    for (const item of list.messages || []) {
      if (!messageRoutes.has(item.id) && messageRoutes.size >= maxMessages) continue;
      if (!messageRoutes.has(item.id)) messageRoutes.set(item.id, new Set());
      messageRoutes.get(item.id).add(plan.route);
    }
  }
  const results = [];
  const verifiedVendorEmails = new Set(normalizeVendorEmails(options.verifiedVendorEmails));

  for (const [messageId, routes] of messageRoutes) {
    const message = await gmailRequest(token, "/messages/" + encodeURIComponent(messageId), { format: "full" });
    const discoveryRoutes = new Set(routes);
    if (discoveryRoutes.has("label") && Number(message.internalDate || 0) < Number(labelPlan?.afterMs || 0)) {
      discoveryRoutes.delete("label");
    }
    if (!discoveryRoutes.size) continue;
    const parts = walkParts(message.payload);
    const from = getHeader(message, "From");
    const senderEmail = extractEmailAddress(from);
    const subject = getHeader(message, "Subject");
    const bodyText = extractPlainText(parts) || extractHtmlBody(parts);
    const invoiceFields = parseInvoiceText(bodyText || message.snippet || "", displayVendor(from) || from);
    const resolvedDiscoveryRoutes = [...discoveryRoutes];
    const senderVerified = Boolean(senderEmail && verifiedVendorEmails.has(senderEmail));

    const looksLikeInvoice = /invoice|amount due|balance due|payment due|amount\s*:|total\s*:|balance\s*:|total due/i.test(subject + "\n" + bodyText);
    if (looksLikeInvoice) {
      results.push({
        messageId,
        threadId: message.threadId,
        messageRfcId: getHeader(message, "Message-ID"),
        from,
        senderEmail,
        senderVerified,
        discoveryRoutes: resolvedDiscoveryRoutes,
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
        const pdfBytes = await downloadAttachment(token, messageId, part.body.attachmentId);
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: pdfBytes });
        const parsed = await parser.getText();
        await parser.destroy();

        results.push({
          messageId,
          threadId: message.threadId,
          messageRfcId: getHeader(message, "Message-ID"),
          from,
          senderEmail,
          senderVerified,
          discoveryRoutes: resolvedDiscoveryRoutes,
          subject,
          date: getHeader(message, "Date"),
          attachment: part.filename || "invoice.pdf",
          source: "gmail-pdf",
          extractionStatus: "parsed",
          ...parseInvoiceText(parsed.text, displayVendor(from) || from)
        });
      } catch (error) {
        results.push({
          messageId,
          threadId: message.threadId,
          messageRfcId: getHeader(message, "Message-ID"),
          from,
          senderEmail,
          senderVerified,
          discoveryRoutes: resolvedDiscoveryRoutes,
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
    query: queries[0].query,
    queries,
    labelResolved: labelPlan ? Boolean(labelId) : null,
    routeMessageCounts,
    messageCount: messageRoutes.size,
    count: results.length,
    invoices: results
  };
}
