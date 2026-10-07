import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
execFileSync("forge", ["build"], { cwd: root, stdio: "inherit" });
const compiledPath = path.join(root, "out", "BusinessPolicyVault.sol", "BusinessPolicyVault.json");
const compiled = JSON.parse(fs.readFileSync(compiledPath, "utf8"));
const bytecode = compiled.bytecode?.object;
const compilerVersion = compiled.metadata?.compiler?.version;
const evmVersion = compiled.metadata?.settings?.evmVersion;
if (!bytecode || !compilerVersion || !evmVersion) throw new Error("Policy vault compiler output is incomplete");

const artifact = {
  contractName: "BusinessPolicyVault",
  abi: compiled.abi,
  bytecode,
  compiler: "solc " + compilerVersion.split("+")[0],
  evmVersion
};

fs.mkdirSync(path.join(root, "contracts", "artifacts"), { recursive: true });
fs.writeFileSync(
  path.join(root, "contracts", "artifacts", "BusinessPolicyVault.json"),
  JSON.stringify(artifact, null, 2) + "\n"
);

console.log("Compiled BusinessPolicyVault:", artifact.bytecode.length / 2, "bytes");
