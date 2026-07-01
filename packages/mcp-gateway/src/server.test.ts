import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import { buildInitializeReplayHeaders, createGatewayServer, type GatewayState } from "./server.js";
import { CircuitBreaker } from "./circuit-breaker.js";

interface StrictMcpUpstream {
  server: http.Server;
  url: string;
  methods: string[];
  receivedHeaders: http.IncomingHttpHeaders[];
  clearSessions: () => void;
  close: () => Promise<void>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function createStrictMcpUpstream(): Promise<StrictMcpUpstream> {
  let nextSession = 1;
  const sessions = new Map<string, { initialized: boolean }>();
  const methods: string[] = [];
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    receivedHeaders.push(req.headers);
    const bodyText = await readBody(req);
    const message = JSON.parse(bodyText) as { id?: number; method?: string };
    const method = message.method ?? "";
    methods.push(method);

    if (method === "initialize") {
      const sessionId = `upstream-${nextSession++}`;
      sessions.set(sessionId, { initialized: false });
      res.statusCode = 200;
      res.setHeader(MCP_SESSION_HEADER, sessionId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2024-11-05" } }));
      return;
    }

    const sessionId = req.headers[MCP_SESSION_HEADER];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    if (method === "notifications/initialized") {
      session.initialized = true;
      res.statusCode = 202;
      res.end();
      return;
    }

    if (!session.initialized) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `method "${method}" is invalid during session initialization` }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result: { ok: true } }));
  });
  const url = await listen(server);
  return {
    server,
    url,
    methods,
    receivedHeaders,
    clearSessions: () => sessions.clear(),
    close: () => closeServer(server),
  };
}

/**
 * POST to the gateway over a raw HTTP/1.1 connection using chunked transfer
 * encoding (Node sets `Transfer-Encoding: chunked` automatically when a body
 * is written without a Content-Length). This faithfully reproduces what the
 * upstream auth-proxy does for some requests — and what the global `fetch`
 * client cannot send (undici forbids a caller-set transfer-encoding header).
 */
function postChunked(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers, // no content-length → Node frames the body as chunked
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function createHangingUpstream(): Promise<{ url: string }> {
  // Never responds — models a hung/dead upstream (figma's OOM / websocket-drop
  // state) so the gateway's own timeout + circuit breaker are exercised rather
  // than inheriting undici's ~300s default timeout.
  const server = http.createServer(() => {
    /* intentionally never calls res.end() */
  });
  const url = await listen(server);
  return { url };
}

async function createGateway(
  upstreamUrl: string,
  opts?: { timeoutMs?: number; failureThreshold?: number },
): Promise<{ url: string; state: GatewayState }> {
  const state: GatewayState = {
    upstreams: { "k8s-admin": upstreamUrl },
    sessions: new Map(),
    upstreamTimeoutMs: opts?.timeoutMs ?? 60_000,
    breaker: new CircuitBreaker({
      failureThreshold: opts?.failureThreshold ?? 5,
      openCooldownMs: 30_000,
      halfOpenMaxProbes: 1,
    }),
  };
  const server = createGatewayServer(state);
  const url = await listen(server);
  return { url: url.replace(/\/mcp$/, "/k8s-admin/mcp"), state };
}

function jsonHeaders(sessionId?: string): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {}),
  };
}

describe("buildInitializeReplayHeaders", () => {
  it("preserves caller auth and identity headers for session replay", () => {
    const headers = buildInitializeReplayHeaders({
      authorization: "Bearer pcp_user_123",
      "x-paperclip-user-id": "user_123",
      "x-paperclip-company-id": "company_123",
      accept: "application/json",
      "content-type": "application/json-rpc",
      [MCP_SESSION_HEADER]: "client-session",
    });

    expect(headers.authorization).toBe("Bearer pcp_user_123");
    expect(headers["x-paperclip-user-id"]).toBe("user_123");
    expect(headers["x-paperclip-company-id"]).toBe("company_123");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[MCP_SESSION_HEADER]).toBeUndefined();
  });
});

describe("mcp gateway lifecycle compatibility", () => {
  it("sends initialized after a client initialize request", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(toolsList.status).toBe(200);
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("bootstraps and initializes an upstream session for unknown non-initialize requests", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(toolsList.status).toBe(200);
    expect(toolsList.headers.get(MCP_SESSION_HEADER)).toBeTruthy();
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("bootstraps unknown tools/call requests that mention initialize in params", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const toolsCall = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "x",
          arguments: {
            note: "initialize",
          },
        },
      }),
    });

    expect(toolsCall.status).toBe(200);
    expect(toolsCall.headers.get(MCP_SESSION_HEADER)).toBeTruthy();
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("strips the hop-by-hop transfer-encoding header from a chunked inbound request", async () => {
    // Regression: undici's fetch throws `UND_ERR_INVALID_ARG: invalid
    // transfer-encoding header` for ANY request whose headers carry
    // `transfer-encoding`. The gateway must strip hop-by-hop headers (RFC 7230
    // §6.1) before forwarding, or every chunked-framed request 502s.
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const res = await postChunked(
      gateway.url,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
      { "content-type": "application/json", accept: "application/json, text/event-stream" },
    );

    expect(res.status).toBe(200);
    // The upstream must never see the hop-by-hop transfer-encoding header.
    for (const headers of upstream.receivedHeaders) {
      expect(headers["transfer-encoding"]).toBeUndefined();
    }
  });

  it("replays initialize and initialized before retrying a missing upstream session", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();

    upstream.clearSessions();
    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(toolsList.status).toBe(200);
    expect(toolsList.headers.get(MCP_SESSION_HEADER)).toBe(clientSessionId);
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });
});

describe("upstream resilience: timeout + circuit breaker", () => {
  it("returns 504 when the upstream hangs past the configured timeout", async () => {
    const hanging = await createHangingUpstream();
    const gateway = await createGateway(hanging.url, { timeoutMs: 200 });

    const start = Date.now();
    const res = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(504);
    // Aborted at ~200ms, not undici's ~300s default header/body timeout.
    expect(elapsed).toBeLessThan(3000);
  });

  it("opens the circuit after repeated failures and then fast-fails with 503", async () => {
    const hanging = await createHangingUpstream();
    const gateway = await createGateway(hanging.url, { timeoutMs: 150, failureThreshold: 2 });
    const call = () =>
      fetch(gateway.url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    // First two calls reach the hung upstream and time out (504), tripping the breaker.
    expect((await call()).status).toBe(504);
    expect((await call()).status).toBe(504);
    expect(gateway.state.breaker.stateOf("k8s-admin")).toBe("open");

    // Third call is short-circuited by the open breaker: 503 (only reachable
    // via the breaker gate) with a retry-after hint, without touching upstream.
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("keeps a healthy upstream closed across many calls", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url, { failureThreshold: 2 });

    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(gateway.url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
    }
    expect(gateway.state.breaker.stateOf("k8s-admin")).toBe("closed");
  });
});
