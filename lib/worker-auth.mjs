import crypto from "node:crypto";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function requireAutonomyWorker(req) {
  const secret = process.env.AUTONOMY_CRON_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("Autonomy worker secret is not configured");
  }
  const authorization = String(req.headers?.authorization || "");
  if (!safeEqual(authorization, "Bearer " + secret)) {
    const error = new Error("Autonomy worker authentication failed");
    error.statusCode = 401;
    throw error;
  }
  return true;
}
