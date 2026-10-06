import { supabaseRest } from "./supabase-server.mjs";

export async function getBusiness(token, userId) {
  const rows = await supabaseRest(
    "businesses?select=*&owner_user_id=eq." + encodeURIComponent(userId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}
