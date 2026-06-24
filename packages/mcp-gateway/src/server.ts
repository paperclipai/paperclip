#!/usr/bin/env node
/**
 * paperclip-mcp-gateway entry point.
 *
 * Listens on $PORT (default 8080) and reverse-proxies inbound MCP
 * requests to upstream MCP servers based on the path prefix. Catches
 * `Session not found` 404s from upstreams and transparently replays
 * the cached `initialize` request to mint a fresh upstream session,
 * then retries the original call. The client never sees the failure.
 *
 * Routing config: env `PAPERCLIP_MCP_UPSTREAMS` (inline JSON) or
 * `PAPERCLIP_MCP_UPSTREAMS_FILE` (path to JSON file).
 *
 * Health check: GET / → 200 with the current upstream table.
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadUpstreams, matchUpstream, type UpstreamMap } from "./upstreams.js";
import {
  MCP_SESSION_HEADER,
  SessionStore,
  isSessionNotFoundResponse,
  looksLikeInitializeRequest,
  extractUpstreamSessionId,
  buildDefaultInitializePayload,
  buildInitializedNotificationPayload,
} from "./session-keepalive.js";

export interface GatewayState {
  upstreams: UpstreamMap;
  sessions: Map<string, SessionStore>;
}

/**
 * Request headers we must NOT copy verbatim to the upstream fetch.
 *
 * `host` is re-derived from the upstream URL. `content-length` and
 * `transfer-encoding` are framing headers that undici recomputes from the
 * body we hand it — critically, undici's fetch rejects ANY request whose
 * headers carry `transfer-encoding` with `UND_ERR_INVALID_ARG: invalid
 * transfer-encoding header`, so a chunked-framed inbound request (as the
 * upstream auth-proxy sends) would 502 if forwarded. The remainder are the
 * RFC 7230 §6.1 hop-by-hop headers, which are per-connection and meaningless
 * on the new gateway→upstream connection.
 *
 * Names are lowercase because Node lowercases all incoming header names.
 */
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

function getOrCreateStore(state: GatewayState, prefix: string): SessionStore {
  const existing = state.sessions.get(prefix);
  if (existing) return existing;
  const fresh = new SessionStore();
  state.sessions.set(prefix, fresh);
  return fresh;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ForwardResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export function buildInitializeReplayHeaders(
  inboundHeaders: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const headers: http.IncomingHttpHeaders = { ...inboundHeaders };
  delete headers[MCP_SESSION_HEADER];
  headers["content-type"] = "application/json";
  headers.accept = "application/json, text/event-stream";
  return headers;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

async function notifyUpstreamInitialized(
  upstreamUrl: string,
  inboundHeaders: http.IncomingHttpHeaders,
  upstreamSessionId: string,
): Promise<boolean> {
  const result = await forward(
    upstreamUrl,
    "POST",
    buildInitializeReplayHeaders(inboundHeaders),
    buildInitializedNotificationPayload(),
    upstreamSessionId,
  );
  if (isSuccess(result.status)) return true;
  // eslint-disable-next-line no-console
  console.warn(`[mcp-gateway] upstream initialized notification failed: status=${result.status}`);
  return false;
}

async function createUpstreamSession(
  upstreamUrl: string,
  inboundHeaders: http.IncomingHttpHeaders,
  initializePayload: Buffer,
): Promise<string | null> {
  const initializeResult = await forward(
    upstreamUrl,
    "POST",
    buildInitializeReplayHeaders(inboundHeaders),
    initializePayload,
    null,
  );
  const initializeBody = initializeResult.body.toString("utf8");
  const upstreamSessionId = extractUpstreamSessionId(initializeResult.headers, initializeBody);
  if (!isSuccess(initializeResult.status) || !upstreamSessionId) return null;
  await notifyUpstreamInitialized(upstreamUrl, inboundHeaders, upstreamSessionId);
  return upstreamSessionId;
}

async function forward(
  upstreamUrl: string,
  method: string,
  inboundHeaders: http.IncomingHttpHeaders,
  body: Buffer,
  upstreamSessionId: string | null,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(inboundHeaders)) {
    if (Array.isArray(v)) {
      headers[k] = v.join(", ");
    } else if (typeof v === "string") {
      headers[k] = v;
    }
  }
  // Strip framing + hop-by-hop headers we shouldn't forward (see
  // STRIPPED_REQUEST_HEADERS). Leaving `transfer-encoding` in place makes
  // undici reject the fetch with UND_ERR_INVALID_ARG.
  for (const h of STRIPPED_REQUEST_HEADERS) delete headers[h];
  // Override Mcp-Session-Id with the upstream id (or remove it for fresh init).
  delete headers[MCP_SESSION_HEADER];
  if (upstreamSessionId) {
    headers[MCP_SESSION_HEADER] = upstreamSessionId;
  }
  const init: RequestInit = {
    method,
    headers,
  };
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    // Buffer subclasses Uint8Array, but TS's RequestInit BodyInit type
    // doesn't include Buffer directly. Cast via Uint8Array — at runtime
    // fetch handles both equivalently.
    init.body = new Uint8Array(body);
  }
  const resp = await fetch(upstreamUrl, init);
  const respBody = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, headers: resp.headers, body: respBody };
}

function writeResponse(
  res: http.ServerResponse,
  result: ForwardResult,
  exposedClientSessionId: string | null,
): void {
  res.statusCode = result.status;
  for (const [k, v] of result.headers.entries()) {
    // Replace upstream's session header with the stable client one.
    if (k.toLowerCase() === MCP_SESSION_HEADER) continue;
    // Skip hop-by-hop headers.
    if (k.toLowerCase() === "transfer-encoding" || k.toLowerCase() === "content-encoding") continue;
    res.setHeader(k, v);
  }
  if (exposedClientSessionId) {
    res.setHeader(MCP_SESSION_HEADER, exposedClientSessionId);
  }
  res.end(result.body);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: GatewayState,
): Promise<void> {
  const url = req.url ?? "/";

  // Health endpoint.
  if (url === "/" || url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      upstreams: Object.keys(state.upstreams),
      sessions: Object.fromEntries(
        Array.from(state.sessions.entries()).map(([prefix, store]) => [prefix, store.size()]),
      ),
    }));
    return;
  }

  const matched = matchUpstream(url, state.upstreams);
  if (!matched) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "no upstream matched",
      path: url,
      knownPrefixes: Object.keys(state.upstreams),
    }));
    return;
  }
  const prefix = (() => {
    const trimmed = url.startsWith("/") ? url.slice(1) : url;
    const slashIdx = trimmed.indexOf("/");
    return slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  })();
  const store = getOrCreateStore(state, prefix);

  const body = await readBody(req);
  const bodyText = body.toString("utf8");
  const clientSessionId = (() => {
    const v = req.headers[MCP_SESSION_HEADER];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  })();

  // Fast path: known client session, look up upstream id, forward.
  if (clientSessionId) {
    const record = store.get(clientSessionId);
    if (record) {
      const result = await forward(matched.upstreamUrl, req.method ?? "POST", req.headers, body, record.upstreamSessionId);
      const text = result.body.toString("utf8");
      if (isSessionNotFoundResponse(result.status, text)) {
        // Replay path: re-issue the cached initialize, get a fresh upstream id, retry.
        if (!record.initializePayload) {
          // No cached initialize — can't recover. Pass the failure through.
          writeResponse(res, result, clientSessionId);
          return;
        }
        const replayInitResult = await forward(
          matched.upstreamUrl,
          "POST",
          buildInitializeReplayHeaders(req.headers),
          record.initializePayload,
          null,
        );
        const replayBody = replayInitResult.body.toString("utf8");
        const newUpstreamId = extractUpstreamSessionId(replayInitResult.headers, replayBody);
        if (isSuccess(replayInitResult.status) && newUpstreamId) {
          await notifyUpstreamInitialized(matched.upstreamUrl, req.headers, newUpstreamId);
          store.rotateUpstream(clientSessionId, newUpstreamId);
          // Retry the original call with the new upstream id.
          const retryResult = await forward(
            matched.upstreamUrl,
            req.method ?? "POST",
            req.headers,
            body,
            newUpstreamId,
          );
          writeResponse(res, retryResult, clientSessionId);
          return;
        }
        // Re-init failed; pass the original 404 through so the client can recover its own way.
        writeResponse(res, result, clientSessionId);
        return;
      }
      writeResponse(res, result, clientSessionId);
      return;
    }
    // Client supplied a sessionId we don't know — treat as new init below.
  }

  const requestMethod = req.method ?? "POST";
  const isInitializeRequest = looksLikeInitializeRequest(bodyText);

  if (!isInitializeRequest && requestMethod !== "GET" && requestMethod !== "HEAD" && body.length > 0) {
    const initializePayload = buildDefaultInitializePayload();
    const upstreamSessionId = await createUpstreamSession(matched.upstreamUrl, req.headers, initializePayload);
    if (upstreamSessionId) {
      const record = store.createInitialized({
        clientSessionId,
        upstreamSessionId,
        initializePayload,
      });
      const retryResult = await forward(
        matched.upstreamUrl,
        requestMethod,
        req.headers,
        body,
        upstreamSessionId,
      );
      writeResponse(res, retryResult, record.clientSessionId);
      return;
    }
  }

  // No (known) session id. If this is an initialize call, capture the
  // response sessionId for future replay, and immediately complete the
  // upstream lifecycle so clients that omit notifications/initialized do
  // not leave the upstream session stuck in its initialization phase.
  const result = await forward(matched.upstreamUrl, requestMethod, req.headers, body, null);
  const text = result.body.toString("utf8");
  if (isInitializeRequest && isSuccess(result.status)) {
    const upstreamId = extractUpstreamSessionId(result.headers, text);
    if (upstreamId) {
      await notifyUpstreamInitialized(matched.upstreamUrl, req.headers, upstreamId);
      const record = store.createInitialized({
        clientSessionId,
        upstreamSessionId: upstreamId,
        initializePayload: body,
      });
      writeResponse(res, result, record.clientSessionId);
      return;
    }
  }
  writeResponse(res, result, clientSessionId ?? null);
}

export function createGatewayServer(state: GatewayState): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, state).catch((e) => safeOnError(e, req, res));
  });
}

function safeOnError(e: unknown, req: http.IncomingMessage, res: http.ServerResponse): void {
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = (cause as { code?: string } | undefined)?.code;
  const causeMessage = (cause as { message?: string } | undefined)?.message;
  // eslint-disable-next-line no-console
  console.error(
    `[mcp-gateway] request handler error: method=${req.method} url=${req.url} cause=${causeCode ?? (e as Error).name}: ${causeMessage ?? (e as Error).message}`,
  );
  if (!res.headersSent) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "gateway error", detail: (e as Error).message }));
  } else {
    res.end();
  }
}

function main(): void {
  const upstreams = loadUpstreams();
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const state: GatewayState = { upstreams, sessions: new Map() };

  const server = createGatewayServer(state);

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-gateway] listening on :${port}; upstreams: ${Object.keys(upstreams).join(", ")}`,
    );
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[mcp-gateway] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
