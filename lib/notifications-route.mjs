import { requireUser, getSupabaseServerSecret, supabaseRest } from "./supabase-server.mjs";
import { getBusiness } from "./businesses.mjs";
import {
  createTelegramLink,
  getBusinessNotificationChannel,
  normalizeNotificationPreferences,
  notificationChannelView,
  sendBusinessNotification
} from "./business-notifications.mjs";

async function audit(secret, user, business, eventType, data = {}) {
  await supabaseRest("audit_events", {
    token: secret, method: "POST", body: {
      user_id: user.id,
      business_id: business.id,
      network: business.wallet_blockchain,
      event_type: eventType,
      actor: "user",
      data
    }
  });
}

export default async function handler(req, res) {
  try {
    const { token, user } = await requireUser(req);
    const business = await getBusiness(token, user.id);
    if (!business) return res.status(409).json({ error: "Complete business onboarding first" });
    const secret = getSupabaseServerSecret();

    if (req.method === "GET") {
      return res.status(200).json({ notification: notificationChannelView(await getBusinessNotificationChannel(business.id)) });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const action = String(req.body?.action || "");
    if (action === "begin_telegram_link") {
      const link = await createTelegramLink({ businessId: business.id, userId: user.id });
      await audit(secret, user, business, "telegram_notifications_link_started", { expires_at: link.expiresAt });
      return res.status(200).json({ link });
    }
    const channel = await getBusinessNotificationChannel(business.id);
    if (!channel || channel.status !== "active") return res.status(409).json({ error: "Connect Telegram first" });

    if (action === "send_test") {
      const result = await sendBusinessNotification(
        business.id,
        "service_attention",
        `InboxPay test alert\nBusiness: ${business.name}\nNetwork: ${business.wallet_blockchain}\nYour business-specific Telegram notifications are working.`,
        { ignorePreferences: true }
      );
      if (!result.delivered) throw new Error("Telegram test alert was not delivered");
      const testedAt = new Date().toISOString();
      await supabaseRest("business_notification_channels?id=eq." + encodeURIComponent(channel.id), {
        token: secret, method: "PATCH", body: { last_tested_at: testedAt, updated_at: testedAt }
      });
      await audit(secret, user, business, "telegram_notifications_tested");
      return res.status(200).json({ ok: true, testedAt });
    }
    if (action === "update_preferences") {
      const preferences = normalizeNotificationPreferences(req.body?.preferences);
      await supabaseRest("business_notification_channels?id=eq." + encodeURIComponent(channel.id), {
        token: secret, method: "PATCH", body: { preferences, updated_at: new Date().toISOString() }
      });
      await audit(secret, user, business, "telegram_notifications_preferences_updated", { preferences });
      return res.status(200).json({ notification: notificationChannelView({ ...channel, preferences }) });
    }
    if (action === "disconnect") {
      await supabaseRest("business_notification_channels?id=eq." + encodeURIComponent(channel.id), {
        token: secret, method: "PATCH", body: { status: "revoked", updated_at: new Date().toISOString() }
      });
      await audit(secret, user, business, "telegram_notifications_disconnected");
      return res.status(200).json({ notification: notificationChannelView(null) });
    }
    return res.status(400).json({ error: "Unsupported notification action" });
  } catch (error) {
    console.error("InboxPay notifications failed:", error);
    const message = error instanceof Error ? error.message : "Notification request failed";
    return res.status(/Authentication required|Invalid or expired/i.test(message) ? 401 : /Too many Telegram connection links/.test(message) ? 429 : 500).json({ error: message });
  }
}
