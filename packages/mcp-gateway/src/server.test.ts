import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import { buildInitializeReplayHeaders, createGatewayServer, type GatewayState } from "./server.js";

interface StrictMcpUpstream {
  server: http.Server;
  url: string;
  methods: string[];
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
  const server = http.createServer(async (req, res) => {
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
    clearSessions: () => sessions.clear(),
    close: () => closeServer(server),
  };
}

async function createGateway(upstreamUrl: string): Promise<{ url: string; state: GatewayState }> {
  const state: GatewayState = { upstreams: { "k8s-admin": upstreamUrl }, sessions: new Map() };
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
