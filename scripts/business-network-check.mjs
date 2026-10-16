import assert from "node:assert/strict";
import {
  assertSupportedNetwork,
  projectBusinessNetwork,
  summarizeNetworkAccounts
} from "../lib/business-networks.mjs";
import { chainFor, rpcFor } from "../lib/policy-sync.mjs";

assert.equal(rpcFor("ARC"), process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io");
assert.equal(rpcFor("ARC-TESTNET"), process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io");
assert.equal(chainFor("ARC"), 5042);
assert.equal(chainFor("ARC-TESTNET"), 5042002);
assert.throws(() => rpcFor("ETH"), /Unsupported settlement network/);
assert.throws(() => chainFor("ETH"), /Unsupported settlement network/);

const base = {
  id: "business-1",
  owner_user_id: "user-1",
  name: "InboxPay QA",
  active_network: "ARC",
  wallet_id: "legacy-mainnet-wallet",
  wallet_address: "0x9999999999999999999999999999999999999999",
  wallet_blockchain: "ARC",
  policy_contract_address: "0x8888888888888888888888888888888888888888"
};

const accounts = [
  {
    id: "network-testnet",
    business_id: "business-1",
    network: "ARC-TESTNET",
    wallet_id: "testnet-wallet",
    wallet_address: "0x1111111111111111111111111111111111111111",
    wallet_blockchain: "ARC-TESTNET",
    wallet_status: "ready",
    policy_contract_address: "0x2222222222222222222222222222222222222222",
    policy_contract_status: "ready"
  },
  {
    id: "network-mainnet",
    business_id: "business-1",
    network: "ARC",
    wallet_id: "mainnet-wallet",
    wallet_address: "0x3333333333333333333333333333333333333333",
    wallet_blockchain: "ARC",
    wallet_status: "ready",
    policy_contract_address: "0x4444444444444444444444444444444444444444",
    policy_contract_status: "ready"
  }
];

assert.equal(assertSupportedNetwork("ARC"), "ARC");
assert.equal(assertSupportedNetwork("ARC-TESTNET"), "ARC-TESTNET");
assert.throws(() => assertSupportedNetwork("ETH"), /Arc Testnet and Arc Mainnet/);

const mainnet = projectBusinessNetwork(base, accounts);
assert.equal(mainnet.active_network, "ARC");
assert.equal(mainnet.wallet_id, "mainnet-wallet");
assert.equal(mainnet.wallet_address, "0x3333333333333333333333333333333333333333");
assert.equal(mainnet.policy_contract_address, "0x4444444444444444444444444444444444444444");

const testnet = projectBusinessNetwork({ ...base, active_network: "ARC-TESTNET" }, accounts);
assert.equal(testnet.active_network, "ARC-TESTNET");
assert.equal(testnet.wallet_id, "testnet-wallet");
assert.equal(testnet.wallet_address, "0x1111111111111111111111111111111111111111");
assert.equal(testnet.policy_contract_address, "0x2222222222222222222222222222222222222222");
assert.notEqual(testnet.wallet_id, mainnet.wallet_id);
assert.notEqual(testnet.policy_contract_address, mainnet.policy_contract_address);

const unprovisioned = projectBusinessNetwork({ ...base, active_network: "ARC-TESTNET" }, [accounts[1]]);
assert.equal(unprovisioned.wallet_id, null);
assert.equal(unprovisioned.wallet_address, null);
assert.equal(unprovisioned.policy_contract_address, null);
assert.equal(unprovisioned.wallet_blockchain, "ARC-TESTNET");
assert.equal(unprovisioned.wallet_status, "not_provisioned");

assert.deepEqual(summarizeNetworkAccounts(accounts), [
  {
    network: "ARC-TESTNET",
    wallet_address: "0x1111111111111111111111111111111111111111",
    wallet_status: "ready",
    policy_contract_address: "0x2222222222222222222222222222222222222222",
    policy_contract_status: "ready"
  },
  {
    network: "ARC",
    wallet_address: "0x3333333333333333333333333333333333333333",
    wallet_status: "ready",
    policy_contract_address: "0x4444444444444444444444444444444444444444",
    policy_contract_status: "ready"
  }
]);

console.log("business network isolation checks passed");
