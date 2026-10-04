import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const sourcePath = path.join(root, "contracts", "BusinessPolicyVault.sol");
const source = fs.readFileSync(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "BusinessPolicyVault.sol": { content: source }
  },
  settings: {
    evmVersion: "paris",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors?.some((e) => e.severity === "error")) {
  console.error(output.errors);
  process.exit(1);
}

const compiled = output.contracts?.["BusinessPolicyVault.sol"]?.BusinessPolicyVault;
if (!compiled?.evm?.bytecode?.object) throw new Error("Policy vault bytecode missing");

const artifact = {
  contractName: "BusinessPolicyVault",
  abi: compiled.abi,
  bytecode: "0x" + compiled.evm.bytecode.object,
  compiler: "solc 0.8.19",
  evmVersion: "paris"
};

fs.mkdirSync(path.join(root, "contracts", "artifacts"), { recursive: true });
fs.writeFileSync(
  path.join(root, "contracts", "artifacts", "BusinessPolicyVault.json"),
  JSON.stringify(artifact, null, 2) + "\n"
);

console.log("Compiled BusinessPolicyVault:", artifact.bytecode.length / 2, "bytes");
