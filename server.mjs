import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInvoices, settleInvoice } from "./lib/inboxpay.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/invoices" && req.method === "GET") {
      return send(res, 200, await getInvoices());
    }
    if (url.pathname === "/api/pay" && req.method === "POST") {
      const body = await readBody(req);
      const result = await settleInvoice(body.invoiceNumber);
      return send(res, 200, { ok: true, message: "Invoice settled on Arc", result });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method Not Allowed" });

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const relative = requested.replace(/^[/\\]+/, "");
    const target = path.resolve(PUBLIC_ROOT, relative);
    if (!target.startsWith(PUBLIC_ROOT + path.sep)) return send(res, 403, { error: "Forbidden" });
    const data = await fs.readFile(target);
    return send(res, 200, data.toString(), MIME[path.extname(target)] || "application/octet-stream");
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    return send(res, status, { error: error instanceof Error ? error.message : "Server error" });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log("InboxPay running on port " + port));
