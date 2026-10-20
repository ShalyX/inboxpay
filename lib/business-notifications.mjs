import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "./secure-tokens.mjs";
import { getSupabaseServerSecret, supabaseRest } from "./supabase-server.mjs";
import { withTimeout } from "./operations-health.mjs";
import { sendOperationsSystemAlert } from "./operations-alerts.mjs";

const LINK_TTL_MS = 10 * 60 * 1000;
const CUSTOMER_NOTIFICATION_EVENTS = new Set(["connection_test"]);

export function hashNotificationLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function parseTelegramStart(text = "") {
  const match = String(text).trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{20,80})$/);
  return match?.[1] || null;
}

export function notificationChannelView(row) {
  if (!row) return { channel: "telegram", status: "not_connected" };
  return {
    channel: "telegram",
    status: row.status === "active" ? "connected" : row.status,
    destinationHint: row.destination_hint,
    chatType: row.chat_type,
    linkedAt: row.linked_at,
    lastTestedAt: row.last_tested_at
  };
}

export async function telegramRequest(method, body, env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram notifications are not configured by the InboxPay operator");
  const response = await withTimeout(fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), 8000, `Telegram ${method}`);
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram ${method} returned ${response.status}`);
  return result.result;
}

export async function sendTelegramMessage(chatId, text, env = process.env) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true
  }, env);
}

export async function ensureTelegramWebhook(env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || secret.length < 24) throw new Error("Telegram webhook verification is not configured");
  const baseUrl = String(env.INBOXPAY_PUBLIC_URL || "https://inboxpay.vercel.app").replace(/\/$/, "");
  await telegramRequest("setWebhook", {
    url: `${baseUrl}/api/config?telegram=webhook`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false
  }, env);
  const bot = await telegramRequest("getMe", {}, env);
  if (!bot?.username) throw new Error("Telegram bot username is unavailable");
  return bot.username;
}

export async function getBusinessNotificationChannel(businessId) {
  const secret = getSupabaseServerSecret();
  const rows = await supabaseRest(
    "business_notification_channels?select=*&business_id=eq." + encodeURIComponent(businessId) +
      "&channel=eq.telegram&limit=1",
    { token: secret }
  );
  return rows?.[0] || null;
}

export async function createTelegramLink({ businessId, userId }) {
  const secret = getSupabaseServerSecret();
  const now = new Date();
  const recent = await supabaseRest(
    "business_notification_link_tokens?select=id&business_id=eq." + encodeURIComponent(businessId) +
      "&created_at=gt." + encodeURIComponent(new Date(now.getTime() - LINK_TTL_MS).toISOString()) + "&limit=3",
    { token: secret }
  );
  if ((recent || []).length >= 3) throw new Error("Too many Telegram connection links. Try again in ten minutes.");
  const code = crypto.randomBytes(24).toString("base64url");
  const username = await ensureTelegramWebhook();
  await supabaseRest("business_notification_link_tokens", {
    token: secret,
    method: "POST",
    body: {
      business_id: businessId,
      user_id: userId,
      channel: "telegram",
      token_hash: hashNotificationLinkToken(code),
      expires_at: new Date(now.getTime() + LINK_TTL_MS).toISOString()
    }
  });
  return { url: `https://t.me/${username}?start=${code}`, expiresAt: new Date(now.getTime() + LINK_TTL_MS).toISOString() };
}

export async function consumeTelegramLink({ code, chatId, chatType = "private" }) {
  const secret = getSupabaseServerSecret();
  const rows = await supabaseRest("rpc/consume_business_telegram_link", {
    token: secret,
    method: "POST",
    body: {
      p_token_hash: hashNotificationLinkToken(code),
      p_destination_encrypted: encryptSecret(String(chatId)),
      p_destination_hint: `Telegram chat •••${String(chatId).slice(-4)}`,
      p_chat_type: ["private", "group", "supergroup", "channel"].includes(chatType) ? chatType : "private"
    }
  });
  return rows?.[0] || null;
}

export async function sendBusinessNotification(businessId, event, text) {
  if (!CUSTOMER_NOTIFICATION_EVENTS.has(event)) {
    throw new Error("Unsupported customer notification event");
  }
  const row = await getBusinessNotificationChannel(businessId);
  if (!row || row.status !== "active") return { configured: false, delivered: false };
  await sendTelegramMessage(decryptSecret(row.destination_encrypted), text);
  return { configured: true, delivered: true, channel: "telegram" };
}

function oneLine(value, limit = 100) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, limit) || "Unknown";
}

export function formatBusinessPaymentNotification(job, businessName) {
  const labels = {
    payment_submitted: "Payment submitted to Circle — awaiting Arc reconciliation",
    payment_confirmed: "Payment confirmed and reconciled on Arc",
    payment_failed: "Payment failed — review before retrying",
    payment_review: "Payment needs review — settlement is not confirmed"
  };
  const label = labels[job?.event_type];
  if (!label) throw new Error("Unsupported customer payment event");
  if (!["ARC", "ARC-TESTNET"].includes(job.network)) throw new Error("Invalid payment notification network");
  const payload = job.payload || {};
  if (!payload.invoice_number || !payload.vendor || payload.amount_usdc == null) {
    throw new Error("Incomplete payment notification snapshot");
  }
  const amount = Number(payload.amount_usdc);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid payment notification amount");
  const lines = [
    `InboxPay · ${label}`,
    `Business: ${oneLine(businessName, 80)}`,
    `Network: ${job.network === "ARC" ? "Arc Mainnet" : "Arc Testnet"}`,
    `Invoice: ${oneLine(payload.invoice_number, 100)}`,
    `Vendor: ${oneLine(payload.vendor, 100)}`,
    `Amount: ${amount.toFixed(6)} USDC`
  ];
  if (job.event_type === "payment_confirmed") {
    if (!/^0x[0-9a-f]{64}$/i.test(String(payload.tx_hash || ""))) throw new Error("Confirmed payment lacks a valid Arc transaction hash");
    lines.push(`Arc transaction: ${payload.tx_hash}`);
  }
  lines.push(`Alert ID: ${job.id}`);
  return lines.join("\n");
}

export async function deliverBusinessPaymentNotifications(token, batchSize = 3) {
  const jobs = await supabaseRest("rpc/claim_business_payment_notifications", {
    token, method: "POST", body: { p_batch_size: batchSize }
  }) || [];
  const results = [];
  for (const job of jobs) {
    let outcome = "retry";
    let errorCode = null;
    let messageId = null;
    try {
      const channels = await supabaseRest(
        "business_notification_channels?select=*&id=eq." + encodeURIComponent(job.channel_id) +
          "&business_id=eq." + encodeURIComponent(job.business_id) +
          "&user_id=eq." + encodeURIComponent(job.user_id) + "&status=eq.active&limit=1",
        { token }
      );
      const channel = channels?.[0];
      if (!channel || channel.linked_at !== job.channel_linked_at) {
        outcome = "skipped";
        errorCode = "destination_changed_or_disconnected";
      } else {
        const businesses = await supabaseRest(
          "businesses?select=id,name,owner_user_id&id=eq." + encodeURIComponent(job.business_id) +
            "&owner_user_id=eq." + encodeURIComponent(job.user_id) + "&limit=1",
          { token }
        );
        const business = businesses?.[0];
        if (!business) {
          outcome = "skipped";
          errorCode = "business_owner_changed";
        } else {
          const message = formatBusinessPaymentNotification(job, business.name);
          const sent = await sendTelegramMessage(decryptSecret(channel.destination_encrypted), message);
          messageId = Number(sent?.message_id) || null;
          outcome = "delivered";
        }
      }
    } catch (error) {
      errorCode = /valid Arc transaction hash|Invalid payment notification|Incomplete payment notification|Unsupported customer payment event/.test(error?.message || "")
        ? "invalid_event_snapshot" : "delivery_unavailable";
      if (errorCode === "invalid_event_snapshot") outcome = "skipped";
      console.warn("InboxPay customer payment alert delivery failed", { jobId: job.id, reason: errorCode });
    }
    const finished = await supabaseRest("rpc/finish_business_payment_notification", {
      token, method: "POST", body: {
        p_job_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome,
        p_telegram_message_id: messageId, p_error: errorCode
      }
    });
    results.push({ id: job.id, outcome, recorded: finished === true });
    if (finished === true && (errorCode === "invalid_event_snapshot" || (outcome === "retry" && job.attempt_count >= 5))) {
      await sendOperationsSystemAlert({
        service: "customer-notification-delivery",
        detail: errorCode === "invalid_event_snapshot"
          ? "A business payment alert has an invalid recorded snapshot"
          : "A business payment alert exhausted its delivery retries",
        action: "Inspect the server-only business_payment_notification_jobs row and Telegram destination",
        incidentKey: `customer-notification:${job.id}`
      }).catch(() => {});
    }
  }
  return results;
}
