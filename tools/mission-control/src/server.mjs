import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createPaperclipClient } from "./paperclip-client.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 61962;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 7_000;
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendMethodNotAllowed(response) {
  response.setHeader("allow", "GET");
  sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
}

function configuredPaperclipOrigin(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl));
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function withTimeout(promise, timeoutMs) {
  const duration = Number(timeoutMs);
  if (!Number.isFinite(duration) || duration <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream timeout")), duration);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function serveStatic(response, pathname, publicDir, method, paperclipBaseUrl) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendJson(response, 400, { error: "INVALID_PATH" });
    return;
  }

  if (relativePath.includes("\0")) {
    sendJson(response, 400, { error: "INVALID_PATH" });
    return;
  }

  const root = await fs.realpath(path.resolve(publicDir)).catch(() => null);
  if (!root) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  const target = path.resolve(root, `.${relativePath}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  const realTarget = await fs.realpath(target).catch(() => null);
  if (!realTarget || (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`))) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(realTarget);
  } catch {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  if (!stat.isFile()) {
    sendJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  if (path.extname(realTarget).toLowerCase() === ".html") {
    const source = await fs.readFile(realTarget, "utf8");
    const body = source.replace(
      /data-paperclip-base-url="[^"]*"/,
      `data-paperclip-base-url="${escapeHtmlAttribute(paperclipBaseUrl)}"`,
    );
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[".html"],
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-cache",
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(body);
    return;
  }

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(realTarget).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(realTarget).pipe(response);
}

export function createServer({
  client,
  baseUrl = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY ?? "",
  fetchImpl,
  requestTimeoutMs,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  publicDir = DEFAULT_PUBLIC_DIR,
} = {}) {
  const paperclip = client ?? createPaperclipClient({
    baseUrl,
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  });
  const paperclipOrigin = configuredPaperclipOrigin(baseUrl);

  return createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? DEFAULT_HOST}`);

    if (requestUrl.pathname === "/healthz") {
      if (request.method !== "GET") return sendMethodNotAllowed(response);
      return sendJson(response, 200, { status: "ok" });
    }

    if (requestUrl.pathname === "/api/mission-control/state") {
      if (request.method !== "GET") return sendMethodNotAllowed(response);
      const companyId = requestUrl.searchParams.get("companyId");
      if (!companyId) return sendJson(response, 400, { error: "COMPANY_ID_REQUIRED" });

      try {
        const state = await withTimeout(paperclip.readCompanyState(companyId), upstreamTimeoutMs);
        return sendJson(response, 200, state);
      } catch {
        return sendJson(response, 503, { error: "CONTROL_PLANE_UNAVAILABLE" });
      }
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      return sendJson(response, 404, { error: "NOT_FOUND" });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return sendMethodNotAllowed(response);
    return serveStatic(response, requestUrl.pathname, publicDir, request.method, paperclipOrigin);
  });
}

export const createMissionControlServer = createServer;

export function startServer({ host = DEFAULT_HOST, port = Number(process.env.PORT ?? DEFAULT_PORT), ...options } = {}) {
  if (!isLoopbackHost(host)) {
    throw new TypeError(`Mission Control only supports loopback hosts; received ${host}`);
  }
  const server = createServer(options);
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Mission Control listening on http://${host}:${actualPort}`);
  });
  return server;
}

export { isLoopbackHost };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startServer();
}
