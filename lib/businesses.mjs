import { supabaseRest } from "./supabase-server.mjs";
import {
  activeBusinessNetwork,
  assertSupportedNetwork,
  projectBusinessNetwork
} from "./business-networks.mjs";

export async function getBusinessRecord(token, userId) {
  const rows = await supabaseRest(
    "businesses?select=*&owner_user_id=eq." + encodeURIComponent(userId) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function getBusinessNetworkAccounts(token, businessId) {
  return await supabaseRest(
    "business_network_accounts?select=*&business_id=eq." + encodeURIComponent(businessId) + "&order=network",
    { token }
  ) || [];
}

export async function getBusiness(token, userId) {
  const business = await getBusinessRecord(token, userId);
  if (!business) return null;
  const accounts = await getBusinessNetworkAccounts(token, business.id);
  return projectBusinessNetwork(business, accounts);
}

export async function getBusinessForNetwork(token, userId, requestedNetwork) {
  const network = assertSupportedNetwork(requestedNetwork);
  const business = await getBusinessRecord(token, userId);
  if (!business) return null;
  const accounts = await getBusinessNetworkAccounts(token, business.id);
  return projectBusinessNetwork({ ...business, active_network: network }, accounts);
}

export async function getBusinessNetworkAccount(token, businessId, network) {
  const selected = assertSupportedNetwork(network);
  const rows = await supabaseRest(
    "business_network_accounts?select=*&business_id=eq." + encodeURIComponent(businessId) +
      "&network=eq." + encodeURIComponent(selected) + "&limit=1",
    { token }
  );
  return rows?.[0] || null;
}

export async function ensureBusinessNetworkAccount(token, business, requestedNetwork) {
  const network = assertSupportedNetwork(requestedNetwork || activeBusinessNetwork(business));
  const existing = await getBusinessNetworkAccount(token, business.id, network);
  if (existing) return existing;

  try {
    const rows = await supabaseRest("business_network_accounts", {
      token,
      method: "POST",
      body: {
        business_id: business.id,
        network,
        wallet_blockchain: network,
        wallet_status: "not_provisioned",
        policy_contract_blockchain: network,
        policy_contract_status: "not_deployed"
      }
    });
    return rows?.[0] || null;
  } catch (error) {
    if (error instanceof Error && /^Supabase 409:/i.test(error.message)) {
      return getBusinessNetworkAccount(token, business.id, network);
    }
    throw error;
  }
}

export async function updateBusinessNetworkAccount(token, businessId, network, patch, match = {}) {
  const selected = assertSupportedNetwork(network);
  let path = "business_network_accounts?business_id=eq." + encodeURIComponent(businessId) +
    "&network=eq." + encodeURIComponent(selected);
  for (const [key, value] of Object.entries(match)) {
    path += "&" + encodeURIComponent(key) + "=eq." + encodeURIComponent(value);
  }
  return await supabaseRest(path, {
    token,
    method: "PATCH",
    body: { ...patch, updated_at: patch.updated_at || new Date().toISOString() }
  }) || [];
}
