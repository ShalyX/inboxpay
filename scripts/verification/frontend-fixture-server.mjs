// LOCAL VISUAL QA ONLY. Not deployed, no credentials, no provider connections.
// Serves the real frontend against deterministic UI fixtures. All payment writes
// are rejected. This verifies presentation, not Gmail/Circle/Arc integrations.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../public/", import.meta.url));
const address = "0x0000000000000000000000000000000000000001";
const business = {
  id: "visual-fixture",
  name: "Example Studio · UI fixture",
  active_network: "ARC-TESTNET",
  wallet_blockchain: "ARC-TESTNET",
  wallet_status: "ready",
  wallet_address: address,
  policy_contract_status: "ready",
  policy_contract_address: address,
  network_accounts: [{ network: "ARC-TESTNET", wallet_status: "ready" }],
};
const policy = {
  max_transaction_usdc: 1000,
  daily_limit_usdc: 2000,
  cash_floor_usdc: 50,
  paused: false,
  autonomy_enabled: false,
};
const invoices = [
  {
    invoiceNumber: "VISUAL-001",
    vendor: "Studio North",
    amount: 240,
    currency: "USDC",
    dueDate: "2026-10-24",
    agentDecision: "ESCALATE",
    decisionReasons: ["Verify this vendor before paying their first invoice."],
    extraction: { confidence: "high" },
    sourceCount: 1,
  },
  {
    invoiceNumber: "VISUAL-002",
    vendor: "Orbit Hosting",
    amount: 89,
    currency: "USDC",
    dueDate: "2026-10-31",
    agentDecision: "SCHEDULE",
    decisionReasons: ["The invoice is due later. Review it on the due date."],
    extraction: { confidence: "high" },
    sourceCount: 2,
  },
  {
    invoiceNumber: "VISUAL-003",
    vendor: "Fieldwork",
    amount: 320,
    currency: "USDC",
    dueDate: "2026-10-18",
    agentDecision: "PAY_NOW",
    decisionReasons: [],
    settlement: { status: "confirmed", reconciled: true },
    extraction: { confidence: "high" },
    sourceCount: 1,
  },
];
const types = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
    const scenario = new URL(req.headers.referer || "http://localhost/").searchParams.get("fixture");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && url.pathname !== "/api/onboarding")
          return json(res, 405, {
            error:
              "Visual fixture: all financial and configuration writes are disabled",
          });
        if (url.pathname === "/api/onboarding")
          return json(res, 200, { business });
        if (url.pathname === "/api/config")
          return json(res, 200, {
            url: "https://example.invalid",
            publishableKey: "fixture-only",
          });
      if (url.pathname === "/api/session")
        return json(res, 200, { gmail: { status: scenario === "disconnected" ? "disconnected" : "connected" } });
        if (url.pathname === "/api/wallet")
          return json(res, 200, { balance: 640.5, withdrawals: [] });
        if (url.pathname === "/api/policy")
          return json(res, 200, {
            business,
            policy,
            onchainPolicy: policy,
            allowance: "1000000000",
            contract: { status: "ready" },
          });
        if (url.pathname === "/api/vendors")
          return json(res, 200, { vendors: [] });
        if (url.pathname === "/api/invoices") {
        if (scenario === "error") return json(res, 503, { error: "Fixture service unavailable" });
          if (url.searchParams.get("unused")) return json(res, 400, {});
          return json(res, 200, {
          invoices: scenario === "empty" ? [] : invoices,
            liveGmail: true,
            evaluatedAt: "2026-10-21T12:00:00Z",
          });
        }
        if (url.pathname === "/api/preflight") {
          const invoice = invoices.find(
            (row) => row.invoiceNumber === url.searchParams.get("invoice"),
          );
          const settled = invoice?.settlement?.reconciled;
          return json(res, 200, {
            preflight: {
              invoiceNumber: invoice?.invoiceNumber,
              eligible: false,
              reasons: settled
                ? ["This fixture invoice is already confirmed and reconciled."]
                : ["The vendor must be explicitly verified for this business."],
              checks: [
                {
                  key: "settlement_state",
                  label: "Payment record",
                  ok: !!settled,
                  value: settled ? "Already settled" : "Not submitted",
                },
                {
                  key: "vendor",
                  label: "Vendor verification",
                  ok: false,
                  value: "Needs review",
                },
              ],
            },
          });
        }
        if (url.pathname === "/api/activity")
          return json(res, 200, { payments: [], events: [], rows: [] });
        return json(res, 404, { error: "No fixture for this route" });
      }
      if (url.pathname === "/fixture-supabase.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        return res.end(
          'export function createClient(){return {auth:{onAuthStateChange(){},async getSession(){return {data:{session:{access_token:"fixture-only",user:{id:"visual-fixture"}}}}}}}}',
        );
      }
      const target = path.resolve(
        root,
        (url.pathname === "/" ? "index.html" : url.pathname).replace(
          /^\/+/,
          "",
        ),
      );
      if (path.relative(root, target).startsWith(".."))
        return json(res, 403, {});
      let data = await readFile(target);
      if (url.pathname === "/inboxpay.js")
        data = Buffer.from(
          data
            .toString()
            .replace(
              '"https://esm.sh/@supabase/supabase-js@2"',
              '"/fixture-supabase.js"',
            ),
        );
      if (url.pathname === "/")
        data = Buffer.from(
          data
            .toString()
            .replace(
              "<body>",
              '<body><div style="position:fixed;bottom:0;right:0;z-index:99;background:#182a49;color:white;padding:6px 12px;font:10px sans-serif;pointer-events:none">LOCAL UI FIXTURE · NO REAL DATA OR PAYMENTS</div>',
            ),
        );
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch {
      json(res, 404, { error: "Not found" });
    }
  })
  .listen(3014, "127.0.0.1", () =>
    console.log(
      "Visual QA fixture at http://localhost:3014 — no live integrations",
    ),
  );
