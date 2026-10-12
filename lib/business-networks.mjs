export const SUPPORTED_NETWORKS = Object.freeze(["ARC-TESTNET", "ARC"]);

const financialFields = Object.freeze([
  "wallet_set_id",
  "wallet_id",
  "wallet_address",
  "wallet_blockchain",
  "wallet_status",
  "wallet_error",
  "policy_contract_id",
  "policy_contract_address",
  "policy_contract_status",
  "policy_contract_tx_id",
  "policy_contract_blockchain",
  "policy_contract_error",
  "policy_contract_configured_at",
  "policy_contract_sync_error"
]);

export function assertSupportedNetwork(value) {
  const network = String(value || "").trim().toUpperCase();
  if (!SUPPORTED_NETWORKS.includes(network)) {
    throw new Error("InboxPay supports Arc Testnet and Arc Mainnet");
  }
  return network;
}

export function activeBusinessNetwork(business) {
  const requested = business?.active_network || business?.wallet_blockchain || "ARC-TESTNET";
  return SUPPORTED_NETWORKS.includes(requested) ? requested : "ARC-TESTNET";
}

export function summarizeNetworkAccounts(accounts = []) {
  return SUPPORTED_NETWORKS.flatMap((network) => {
    const account = accounts.find((entry) => entry?.network === network);
    if (!account) return [];
    return [{
      network,
      wallet_address: account.wallet_address || null,
      wallet_status: account.wallet_status || "not_provisioned",
      policy_contract_address: account.policy_contract_address || null,
      policy_contract_status: account.policy_contract_status || "not_deployed"
    }];
  });
}

export function projectBusinessNetwork(business, accounts = []) {
  if (!business) return null;
  const activeNetwork = activeBusinessNetwork(business);
  const account = accounts.find((entry) => entry?.network === activeNetwork) || null;
  const projected = {
    ...business,
    active_network: activeNetwork,
    network_account_id: account?.id || null,
    network_accounts: summarizeNetworkAccounts(accounts)
  };

  for (const field of financialFields) projected[field] = account?.[field] ?? null;
  projected.wallet_blockchain = account?.wallet_blockchain || activeNetwork;
  projected.wallet_status = account?.wallet_status || "not_provisioned";
  projected.policy_contract_blockchain = account?.policy_contract_blockchain || activeNetwork;
  projected.policy_contract_status = account?.policy_contract_status || "not_deployed";
  projected.network_account_updated_at = account?.updated_at || null;
  return projected;
}
