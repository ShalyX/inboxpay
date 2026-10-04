function requireConfig(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name);
  return value;
}

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ecportgmionyhlofyobc.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

export function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export async function requireUser(req) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Authentication required");

  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: requireConfig("SUPABASE_PUBLISHABLE_KEY"),
      Authorization: "Bearer " + token
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id) throw new Error("Invalid or expired InboxPay session");
  return { token, user: body };
}

export async function supabaseRest(path, { token, method = "GET", body } = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: requireConfig("SUPABASE_PUBLISHABLE_KEY"),
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(body ? { Prefer: "return=representation" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error("Supabase " + response.status + ": " + (data?.message || data?.hint || text || response.statusText));
  }
  return data;
}

export function publicSupabaseConfig() {
  return {
    url: SUPABASE_URL,
    publishableKey: requireConfig("SUPABASE_PUBLISHABLE_KEY")
  };
}
