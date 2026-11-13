import { describe, expect, it } from "vitest";
import {
  initializeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
  readMcpHttpResponse,
} from "../services/mcp-http.js";

describe("MCP response progress", () => {
  it("retains consumed SSE progress when a partial event fails and releases the reader", async () => {
    const partial = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":';
    const failure = new Error("peer reset");
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(partial));
        else controller.error(failure);
      },
    }, { highWaterMark: 0 });
    let progress: unknown;
    await expect(readMcpHttpResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), "request", {
      onProgress: (value) => { progress = value; },
    })).rejects.toBe(failure);
    expect(progress).toEqual({ bytesReceived: Buffer.byteLength(partial), chunksReceived: 1, eventsReceived: 1, matchedResponse: false, ended: false });
    expect(body.locked).toBe(false);
  });
});

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

describe("initializeMcpHttpSession", () => {
  it("returns the negotiated protocol and ephemeral session headers", async () => {
    const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
    const sessionHeaders = await initializeMcpHttpSession({
      requestId: "test-request",
      headers: { Authorization: "Bearer token" },
      send: async (init) => {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ headers: new Headers(init.headers), payload });
        if (payload.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "stateful-test", version: "1" },
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-123" },
          });
        }
        return new Response(null, { status: 202 });
      },
    });

    // A legacy server does not answer `server/discover`, so it gets the handshake.
    expect(requests.map(({ payload }) => payload.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
    expect(requests[2]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[2]!.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[2]!.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(sessionHeaders).toMatchObject({
      Authorization: "Bearer token",
      "Mcp-Session-Id": "session-123",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
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

describe("MCP progress notifications", () => {
  it("sends the progress token in the request's _meta and keeps other metadata", async () => {
    const { mcpHttpRequestInit } = await import("../services/mcp-http.js");
    const init = mcpHttpRequestInit({ "MCP-Protocol-Version": "2026-07-28" }, {
      id: "call-1", method: "tools/call", params: { name: "export", arguments: {}, _meta: { other: true } },
    }, { progressToken: "token-1" });
    const meta = JSON.parse(init.body).params._meta;
    expect(meta.progressToken).toBe("token-1");
    expect(meta.other).toBe(true);
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    const without = mcpHttpRequestInit(undefined, { id: "call-2", method: "tools/call", params: { name: "export" } });
    expect(JSON.parse(without.body).params._meta?.progressToken).toBeUndefined();
  });

  it("reads progress interleaved with the result on one SSE stream, before the result", async () => {
    const { mcpProgressNotificationOf } = await import("../services/mcp-http.js");
    const frames = [
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "token-1", progress: 1, total: 3, message: "Exporting rows" } },
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "unrelated" } },
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "someone-else", progress: 9 } },
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "token-1", progress: 2, total: 3 } },
      { jsonrpc: "2.0", id: "call-1", result: { content: [{ type: "text", text: "done" }] } },
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "token-1", progress: 3, total: 3 } },
    ];
    // Split mid-event so frames cross chunk boundaries.
    const text = frames.map((frame) => `event: message\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join("");
    const encoded = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < encoded.length; i += 37) controller.enqueue(encoded.slice(i, i + 37));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    let resultSeenBeforeProgress = false;
    const result = await readMcpHttpResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), "call-1", {
      onNotification: (message) => {
        const update = mcpProgressNotificationOf(message, "token-1");
        if (update) seen.push(update);
      },
      onProgress: (progress) => { if (progress.matchedResponse && seen.length === 0) resultSeenBeforeProgress = true; },
    });
    expect(result).toMatchObject({ id: "call-1", result: { content: [{ text: "done" }] } });
    expect(resultSeenBeforeProgress).toBe(false);
    expect(seen).toEqual([
      { progress: 1, total: 3, message: "Exporting rows" },
      { progress: 2, total: 3, message: undefined },
    ]);
  });

  it("never lets a failing progress observer fail the call", async () => {
    const text = [
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1 } },
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    const result = await readMcpHttpResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }), 7, {
      onNotification: () => { throw new Error("observer broke"); },
    });
    expect(result).toMatchObject({ result: { ok: true } });
  });

  it("ignores requests, responses and other tokens", async () => {
    const { mcpProgressNotificationOf } = await import("../services/mcp-http.js");
    expect(mcpProgressNotificationOf({ method: "notifications/progress", params: { progressToken: "t", progress: 1 } }, undefined)).toBeNull();
    expect(mcpProgressNotificationOf({ id: 1, method: "notifications/progress", params: { progressToken: "t", progress: 1 } }, "t")).toBeNull();
    expect(mcpProgressNotificationOf({ method: "notifications/progress", params: { progressToken: "x", progress: 1 } }, "t")).toBeNull();
    expect(mcpProgressNotificationOf({ method: "notifications/progress", params: { progressToken: "t", progress: 1 } }, "t")).toEqual({ progress: 1, total: undefined, message: undefined });
  });

  it("does not count handled progress against the result's size limit", async () => {
    const note = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1, message: "x".repeat(200) } })}\n\n`;
    const text = note.repeat(50) + `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(5_000);
    const result = await readMcpHttpResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }), 1, { maxBytes: 1_000, limitPerMessage: true });
    expect(result).toMatchObject({ result: { ok: true } });
    // Callers without an overall deadline (catalog discovery) keep the total limit,
    // so a stream of small notifications cannot keep them waiting forever.
    await expect(readMcpHttpResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }), 1, { maxBytes: 1_000 }))
      .rejects.toMatchObject({ reason: "too_large" });
  });

  it("still rejects one SSE message over the limit, complete or not", async () => {
    const big = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(2_000) } })}`;
    for (const text of [`${big}\n\n`, big]) {
      await expect(readMcpHttpResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }), 1, { maxBytes: 1_000, limitPerMessage: true }))
        .rejects.toMatchObject({ reason: "too_large" });
    }
  });
});
