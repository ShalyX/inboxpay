const DEFAULT_ORIGINS = [
  "https://inboxpay.vercel.app",
  "https://tameion-ap-agent-live.vercel.app"
];
const LEGACY_CALLBACK = "https://tameion-ap-agent-live.vercel.app/api/gmail/callback";

function allowedOrigins() {
  const configured = process.env.GMAIL_OAUTH_ALLOWED_ORIGINS;
  const origins = configured === undefined ? DEFAULT_ORIGINS : configured.split(",").map((value) => value.trim());
  if (!origins.length || origins.some((value) => !value)) throw new Error("Invalid Gmail OAuth origin configuration");
  return origins.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash || value.includes("*") ||
        !/^https:\/\/[^/?#]+\/?$/.test(value)) {
      throw new Error("Gmail OAuth origins must be explicit HTTPS origins without paths, credentials or wildcards");
    }
    return url.origin;
  });
}

export function gmailCallbackUri(req) {
  // Host can only select a preconfigured origin; forwarded headers are never trusted.
  const host = req.headers?.host;
  if (typeof host !== "string") throw new Error("Unrecognized Gmail OAuth host");
  const origin = allowedOrigins().find((value) => new URL(value).host === host.toLowerCase());
  if (!origin) throw new Error("Unrecognized Gmail OAuth host");
  return origin + "/api/gmail/callback";
}

export function gmailStateCallbackUri(req, session) {
  const currentUri = gmailCallbackUri(req);
  // Preserve only genuine in-flight cookies minted for the previous fixed callback.
  const oldCookie = session.redirectUri === undefined && session.clientId === undefined;
  const stateUri = oldCookie ? LEGACY_CALLBACK : session.redirectUri;
  if (stateUri !== currentUri || (!oldCookie && session.clientId !== process.env.GMAIL_CLIENT_ID)) {
    throw new Error("Gmail connection origin or client changed. Please start again.");
  }
  return currentUri;
}
