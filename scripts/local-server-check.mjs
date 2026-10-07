import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 3100 + Math.floor(Math.random() * 200);
const child = spawn(process.execPath, ["dev-server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local server did not start")), 5000);
    const onData = () => {
      if (output.includes("InboxPay running on port")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) reject(new Error("Local server exited before listening: " + output));
    });
  });

  const root = await fetch("http://127.0.0.1:" + port + "/");
  assert.equal(root.status, 200);
  assert.match(await root.text(), /InboxPay/);

  const script = await fetch("http://127.0.0.1:" + port + "/inboxpay.js");
  assert.equal(script.status, 200);
  assert.match(await script.text(), /function bootstrap/);

  const head = await fetch("http://127.0.0.1:" + port + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const session = await fetch("http://127.0.0.1:" + port + "/api/session");
  assert.equal(session.status, 401);
  assert.match(await session.text(), /Authentication required/);

  const dueReview = await fetch("http://127.0.0.1:" + port + "/api/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "review_due" })
  });
  assert.equal(dueReview.status, 401);

  const missing = await fetch("http://127.0.0.1:" + port + "/missing");
  assert.equal(missing.status, 404);
} finally {
  child.kill();
}

console.log("local server checks passed");
