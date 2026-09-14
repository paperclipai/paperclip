import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { connectGuardedRemoteHttpSocket } from "../remote-http-fetch.js";
import { PREVIEW_COOKIE } from "./preview-access.js";

export const PREVIEW_INTERNAL_PATH = "/.paperclip/";
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const privateHeader = (name: string) => /^(x-paperclip-|x-daytona-|x-forwarded-|forwarded$)/i.test(name);

export function previewProxyRequestHeaders(input: IncomingHttpHeaders, upstream: { url: string; headers: Record<string, string> }, origin: string, websocket = false) {
  const omitted = new Set([...hopHeaders, ...(input.connection ?? "").toLowerCase().split(",").map((s) => s.trim())]);
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !omitted.has(name) && !privateHeader(name) && !["host", "cookie", "accept-encoding", "if-none-match", "if-modified-since"].includes(name)) output[name] = value;
  }
  const cookies = (input.cookie ?? "").split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith(`${PREVIEW_COOKIE}=`));
  if (cookies.length) output.cookie = cookies.join("; ");
  output.host = new URL(upstream.url).host;
  output["accept-encoding"] = "identity";
  output["x-forwarded-host"] = new URL(origin).host;
  output["x-forwarded-proto"] = new URL(origin).protocol.slice(0, -1);
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!["x-daytona-preview-token", "x-daytona-skip-preview-warning", "x-daytona-disable-cors", "x-daytona-trust-forwarded-host", "x-daytona-skip-last-activity-update"].includes(name.toLowerCase())) throw new Error("Unsupported provider credential header");
    output[name] = value;
  }
  if (websocket) { output.connection = "Upgrade"; output.upgrade = "websocket"; }
  return output;
}

export function previewProxyResponseHeaders(input: IncomingHttpHeaders, upstreamOrigin: string, origin: string) {
  const result: Record<string, string | string[]> = {};
  const omitted = new Set([...hopHeaders, ...(input.connection ?? "").toLowerCase().split(",").map((s) => s.trim())]);
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !omitted.has(name) && !privateHeader(name) && !["set-cookie", "location", "clear-site-data", "alt-svc", "content-length"].includes(name)) result[name] = value;
  }
  const cookies = (input["set-cookie"] ?? []).filter((cookie) => cookie.split("=")[0]?.trim() !== PREVIEW_COOKIE)
    .map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ""));
  if (cookies.length) result["set-cookie"] = cookies;
  if (input.location) {
    const target = new URL(input.location, upstreamOrigin);
    result.location = target.origin === upstreamOrigin ? `${origin}${target.pathname}${target.search}${target.hash}` : input.location;
  }
  result["cache-control"] = "no-store";
  result["referrer-policy"] = "no-referrer";
  result["x-content-type-options"] = "nosniff";
  result["service-worker-allowed"] = "/.paperclip/no-service-workers/";
  // Prevent document.domain relaxation even in browsers that still offer it.
  result["origin-agent-cluster"] = "?1";
  // Preserve app CSP rather than weakening it or disabling its inline scripts
  // by adding a nonce policy. A restrictive app may block visibility signals;
  // Paperclip reports their absence and retains explicit lifetime controls.
  return result;
}

export async function previewProxySocket(upstream: { url: string; headers: Record<string, string> }, provider: string) {
  const endpoint = new URL(upstream.url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Invalid provider preview endpoint");
  if (provider === "local") {
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) < 1024) throw new Error("Invalid local preview endpoint");
  } else if (provider !== "daytona" || endpoint.protocol !== "https:") throw new Error("Invalid sandbox preview endpoint");
  return connectGuardedRemoteHttpSocket(endpoint, { allowPrivateNetwork: provider === "local", error: () => new Error("Preview upstream is unavailable"), connectTimeoutMs: 10_000 });
}

/** Stream arbitrary app traffic without forwarding control-plane cookies. */
export async function proxyPreviewHttp(input: { req: IncomingMessage; res: ServerResponse; upstream: { url: string; headers: Record<string, string> }; provider: string; origin: string; path?: string; instrument?: boolean; authorize?: () => Promise<unknown> }) {
  const { req, res, upstream, provider, origin } = input;
  const socket = await previewProxySocket(upstream, provider);
  if (res.destroyed) { socket.destroy(); return; }
  const endpoint = new URL(upstream.url);
  const requestFn = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const request = requestFn({ host: endpoint.hostname, port: endpoint.port || 443, createConnection: () => socket, setHost: false,
      method: input.path ? "GET" : req.method, path: input.path ?? req.url, headers: previewProxyRequestHeaders(req.headers, upstream, origin),
    });
    const deadline = setTimeout(() => request.destroy(new Error("Preview did not respond in time")), 30_000);
    deadline.unref();
    request.once("error", (error) => { socket.destroy(); reject(error); });
    request.once("close", () => clearTimeout(deadline));
    res.once("close", () => { request.destroy(); socket.destroy(); resolve(); });
    req.once("aborted", () => request.destroy());
    request.once("response", async (response) => {
      clearTimeout(deadline);
      response.setTimeout(60_000, () => response.destroy(new Error("Preview response stalled")));
      response.once("error", reject);
      const html = input.instrument !== false && req.method !== "HEAD" && (response.headers["content-type"] ?? "").toLowerCase().includes("text/html");
      const nonce = html ? randomBytes(18).toString("base64url") : undefined;
      const headers = previewProxyResponseHeaders(response.headers, endpoint.origin, origin);
      try {
        if (html) {
          const encoding = response.headers["content-encoding"];
          if (encoding && !["identity", "gzip", "br", "deflate"].includes(encoding)) throw new Error("Unsupported preview HTML encoding");
          const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
          const stream = decoder ? response.pipe(decoder) : response;
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) throw new Error("Preview HTML exceeds the instrumentation limit");
            chunks.push(Buffer.from(chunk));
          }
          delete headers["content-encoding"];
          delete headers.etag;
          delete headers["content-md5"];
          delete headers.digest;
          const body = Buffer.concat(chunks).toString("utf8");
          const script = `<script nonce="${nonce}" src="${PREVIEW_INTERNAL_PATH}visibility.js"></script>`;
          // Insert ahead of app scripts and meta policies. Restrictive app meta
          // CSP may still block later signals; the UI reports when none arrive.
          const content = /<head(?:\s[^>]*)?>/i.test(body) ? body.replace(/<head(?:\s[^>]*)?>/i, (head) => head + script) : script + body;
          res.writeHead(response.statusCode ?? 502, headers); res.end(content); resolve();
        } else {
          res.writeHead(response.statusCode ?? 502, headers); response.pipe(res); response.once("end", resolve);
        }
      } catch (error) { response.destroy(); reject(error); }
    });
    if (input.authorize) {
      let checking = false;
      const validation = setInterval(() => {
        if (checking) return; checking = true;
        void input.authorize!().catch(() => { res.destroy(); request.destroy(); }).finally(() => { checking = false; });
      }, 2_000); validation.unref(); res.once("close", () => clearInterval(validation));
    }
    if (input.path) request.end(); else req.pipe(request);
  });
}

/** Preserve the application's raw WebSocket handshake and subprotocols. */
export async function proxyPreviewWebSocket(input: { req: IncomingMessage; client: Duplex; head: Buffer; upstream: { url: string; headers: Record<string, string> }; provider: string; origin: string; authorize: () => Promise<unknown> }) {
  const { req, client, head, upstream, provider, origin } = input;
  const socket = await previewProxySocket(upstream, provider);
  if (client.destroyed) { socket.destroy(); return; }
  const endpoint = new URL(upstream.url);
  const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)({ host: endpoint.hostname, port: endpoint.port || 443, createConnection: () => socket,
    setHost: false, method: "GET", path: req.url, headers: previewProxyRequestHeaders(req.headers, upstream, origin, true),
  });
  const timer = setTimeout(() => { request.destroy(); client.destroy(); }, 15_000); timer.unref();
  const close = () => { clearTimeout(timer); request.destroy(); socket.destroy(); client.destroy(); };
  client.once("error", close); client.once("close", close); request.once("error", close);
  request.once("response", (response) => { response.resume(); close(); });
  request.once("upgrade", (response, remote, remoteHead) => {
    clearTimeout(timer);
    const headers = previewProxyResponseHeaders(response.headers, endpoint.origin, origin);
    headers.connection = "Upgrade"; headers.upgrade = "websocket";
    const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((entry) => `${name}: ${entry}`));
    client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (remoteHead.length) client.write(remoteHead); if (head.length) remote.write(head);
    remote.once("error", close); remote.once("close", close); client.pipe(remote).pipe(client);
    let checking = false;
    const validation = setInterval(() => {
      if (checking) return; checking = true;
      void input.authorize().catch(close).finally(() => { checking = false; });
    }, 2_000); validation.unref(); client.once("close", () => clearInterval(validation));
  });
  request.end();
}
