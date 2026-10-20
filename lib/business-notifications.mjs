import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "./secure-tokens.mjs";
import { getSupabaseServerSecret, supabaseRest } from "./supabase-server.mjs";
import { withTimeout } from "./operations-health.mjs";

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
