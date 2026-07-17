import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeMcpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
} from "../services/mcp-http.js";

describe("mcpHttpRequestHeaders", () => {
  it("advertises both JSON and SSE on every request", () => {
    expect(mcpHttpRequestHeaders()).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(MCP_HTTP_ACCEPT).toBe("application/json, text/event-stream");
  });

  it("preserves caller-supplied headers while keeping the required Accept value", () => {
    expect(mcpHttpRequestHeaders({ Authorization: "Bearer x", accept: "application/json" })).toMatchObject({
      accept: "application/json, text/event-stream",
      Authorization: "Bearer x",
    });
  });
});

describe("initializeMcpSession", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("runs the initialize handshake first and returns the assigned session id", async () => {
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ body, headers: init.headers as Record<string, string> });
      if (body.method === "initialize") {
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-123" } },
        );
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const sessionId = await initializeMcpSession("https://mcp.example/mcp", { Authorization: "Bearer x" });

    expect(sessionId).toBe("sess-123");
    // First call is `initialize` with the required Accept header and protocol version.
    expect(calls[0].body.method).toBe("initialize");
    expect((calls[0].body.params as Record<string, unknown>).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(calls[0].headers.accept).toBe("application/json, text/event-stream");
    expect(calls[0].headers.Authorization).toBe("Bearer x");
    // Then `notifications/initialized`, echoing the session id back.
    expect(calls[1].body.method).toBe("notifications/initialized");
    expect(calls[1].headers["mcp-session-id"]).toBe("sess-123");
  });

  it("returns null for a stateless server that omits the session id", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
    expect(await initializeMcpSession("https://mcp.example/mcp")).toBeNull();
  });

  it("returns null when the handshake is rejected, deferring to the follow-up request", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    expect(await initializeMcpSession("https://mcp.example/mcp")).toBeNull();
  });

  it("returns null on a network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await initializeMcpSession("https://mcp.example/mcp")).toBeNull();
  });
});

describe("parseMcpHttpResponseBody", () => {
  it("parses a plain application/json body", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [] } };
    expect(parseMcpHttpResponseBody(JSON.stringify(payload), "application/json")).toEqual(payload);
  });

  it("parses an SSE-framed body, extracting the JSON-RPC message", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [{ name: "kv_get" }] } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream; charset=utf-8")).toEqual(payload);
  });

  it("skips non-JSON-RPC SSE events and returns the response message", () => {
    const ping = "event: ping\ndata: {\"type\":\"ping\"}";
    const message = { jsonrpc: "2.0", id: "1", result: { ok: true } };
    const body = `${ping}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(message);
  });

  it("handles multi-line SSE data fields", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { note: "line" } };
    const json = JSON.stringify(payload, null, 2);
    const body = `data: ${json.split("\n").join("\ndata: ")}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(payload);
  });

  it("throws when an SSE stream carries no data events", () => {
    expect(() => parseMcpHttpResponseBody("event: ping\n\n", "text/event-stream")).toThrow();
  });
});
