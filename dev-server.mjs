import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const API_ROUTES = Object.freeze({
  "/api/activity": "api/activity.mjs",
  "/api/config": "api/config.mjs",
  "/api/gmail/start": "api/gmail/start.mjs",
  "/api/gmail/callback": "api/gmail/callback.mjs",
  "/api/invoices": "api/invoices.mjs",
  "/api/onboarding": "api/onboarding.mjs",
  "/api/pay": "api/pay.mjs",
  "/api/policy": "api/policy.mjs",
  "/api/preflight": "api/preflight.mjs",
  "/api/session": "api/session.mjs",
  "/api/vendors": "api/vendors.mjs",
  "/api/wallet": "api/wallet.mjs"
});
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function responseAdapter(nodeResponse) {
  let statusCode = 200;
  const adapter = {
    status(code) {
      statusCode = code;
      return adapter;
    },
    setHeader(name, value) {
      nodeResponse.setHeader(name, value);
      return adapter;
    },
    json(body) {
      if (!nodeResponse.headersSent) {
        nodeResponse.statusCode = statusCode;
        nodeResponse.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      nodeResponse.end(JSON.stringify(body));
      return adapter;
    },
    end(body = "") {
      if (!nodeResponse.headersSent) nodeResponse.statusCode = statusCode;
      nodeResponse.end(body);
      return adapter;
    },
    redirect(code, location) {
      nodeResponse.statusCode = typeof code === "number" ? code : 302;
      nodeResponse.setHeader("Location", typeof code === "number" ? location : code);
      nodeResponse.end();
      return adapter;
    }
  };
  return adapter;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = chunks.join("");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch { reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

function queryObject(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = query[key] === undefined
      ? value
      : Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
  }
  return query;
}

async function dispatchApi(req, nodeResponse, url) {
  const relative = API_ROUTES[url.pathname];
  if (!relative) {
    send(nodeResponse, 404, { error: "API route not found" });
    return;
  }

  const handlerModule = await import(pathToFileURL(path.join(ROOT, relative)).href);
  const handlerRequest = Object.create(req);
  handlerRequest.method = req.method;
  handlerRequest.url = url.pathname + url.search;
  handlerRequest.query = queryObject(url);
  handlerRequest.body = ["GET", "HEAD"].includes(req.method) ? {} : await readBody(req);
  await handlerModule.default(handlerRequest, responseAdapter(nodeResponse));
  if (!nodeResponse.writableEnded) nodeResponse.end();
}

async function serveStatic(nodeResponse, url, method) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.resolve(PUBLIC_ROOT, requested.replace(/^[/\\]+/, ""));
  const relative = path.relative(PUBLIC_ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    send(nodeResponse, 403, { error: "Forbidden" });
    return;
  }
  const data = await fs.readFile(target);
  nodeResponse.statusCode = 200;
  nodeResponse.setHeader("Content-Type", MIME[path.extname(target)] || "application/octet-stream");
  nodeResponse.end(method === "HEAD" ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await dispatchApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "Method Not Allowed" });
      return;
    }
    await serveStatic(res, url, req.method);
  } catch (error) {
    console.error("InboxPay local request failed:", error);
    if (!res.writableEnded) send(res, error?.statusCode || (error?.code === "ENOENT" ? 404 : 500), {
      error: error instanceof Error ? error.message : "Server error"
    });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log("InboxPay running on port " + port));
