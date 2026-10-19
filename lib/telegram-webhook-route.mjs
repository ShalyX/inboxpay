import crypto from "node:crypto";
import { consumeTelegramLink, parseTelegramStart, sendTelegramMessage } from "./business-notifications.mjs";

function validSecret(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!validSecret(req.headers["x-telegram-bot-api-secret-token"], process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  try {
    const message = req.body?.message;
    const code = parseTelegramStart(message?.text);
    if (!code || message?.chat?.id == null) return res.status(200).json({ ok: true });
    const link = await consumeTelegramLink({ code, chatId: message.chat.id, chatType: message.chat.type });
    if (!link) {
      await sendTelegramMessage(message.chat.id, "This InboxPay connection link is invalid or expired. Create a new link from Business → Notifications.");
      return res.status(200).json({ ok: true });
    }
    await sendTelegramMessage(message.chat.id, "Telegram alerts are now connected to this InboxPay business. Return to InboxPay and refresh the connection status.").catch((error) => {
      console.error("InboxPay Telegram confirmation failed:", error);
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("InboxPay Telegram webhook failed:", error);
    return res.status(503).json({ ok: false });
  }
}
