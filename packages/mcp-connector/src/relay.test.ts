import type { McpConnectorRequestFrame } from "@paperclipai/shared/mcp-connector-protocol";
import { describe, expect, it, vi } from "vitest";
import type { UpstreamConfig } from "./config.js";
import { relayRequest } from "./relay.js";
import { reconnectDelay } from "./connector.js";

const upstreams = new Map<string, UpstreamConfig>([
  ["unifi", { url: "http://unifi.internal:3000/mcp", headers: { authorization: "Bearer local" } }],
]);

function frame(overrides: Partial<McpConnectorRequestFrame> = {}): McpConnectorRequestFrame {
  return {
    type: "request",
    id: "req-1",
    upstream: "unifi",
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    rpcId: 7,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("relayRequest", () => {
  it("refuses an unknown upstream without any network activity", async () => {
    const fetch = vi.fn();
    const result = await relayRequest(frame({ upstream: "metadata" }), upstreams, new AbortController().signal, { fetch });
    expect(result).toMatchObject({ type: "error", code: "upstream_unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dials only the configured URL, strips transport headers and lets local headers win", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }),
      { headers: { "content-type": "application/json", "mcp-session-id": "s1", "set-cookie": "a=b" } },
    ));
    const result = await relayRequest(frame({
      headers: { host: "evil", cookie: "x", authorization: "Bearer from-paperclip", "mcp-session-id": "s1" },
    }), upstreams, new AbortController().signal, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch.mock.calls[0]![0]).toBe("http://unifi.internal:3000/mcp");
    const init = fetch.mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({ authorization: "Bearer local", "mcp-session-id": "s1" });
    expect(result).toMatchObject({ type: "response", status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    expect((result as { headers: Record<string, string> }).headers["set-cookie"]).toBeUndefined();
  });

  it("stops reading an SSE stream once the matching JSON-RPC response arrives", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n"));
        else if (pulls === 2) controller.enqueue(encoder.encode("event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\n\r\n"));
        // Never closes: a server that keeps the stream open must not stall the relay.
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const result = await relayRequest(frame(), upstreams, new AbortController().signal, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.type).toBe("response");
    expect((result as { body: string }).body).toContain("\"id\":7");
  });

  it("enforces the response size limit", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(2048), { headers: { "content-type": "application/json" } }));
    const result = await relayRequest(frame(), upstreams, new AbortController().signal, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxResponseBytes: 1024,
    });
    expect(result).toMatchObject({ type: "error", code: "response_too_large" });
  });

  it("reports an unreachable upstream without echoing the error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:3000 secret-detail");
    });
    const result = await relayRequest(frame(), upstreams, new AbortController().signal, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result).toMatchObject({ type: "error", code: "upstream_unreachable" });
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });
});

describe("reconnectDelay", () => {
  it("applies bounded full jitter", () => {
    const bounds = { baseMs: 1_000, maxMs: 60_000 };
    expect(reconnectDelay(0, bounds, () => 0)).toBe(500);
    expect(reconnectDelay(3, bounds, () => 0.999)).toBeLessThanOrEqual(8_000);
    expect(reconnectDelay(30, bounds, () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});
