import { describe, expect, it } from "vitest";
import {
  initializeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
  readMcpHttpResponse,
} from "../services/mcp-http.js";

describe("bounded MCP responses", () => {
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

  for (const contentType of ["application/json", "text/event-stream"]) {
    it(`rejects declared ${contentType} overflow before consuming the body`, async () => {
      let reads = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const response = new Response(body, {
        headers: { "content-type": contentType, "content-length": "101" },
      });
      await expect(readMcpHttpResponse(response, "request", { maxBytes: 100 })).rejects.toMatchObject({
        name: "McpHttpResponseError", reason: "too_large", maxBytes: 100, responseBytes: 101,
      });
      expect(reads).toBe(0);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it(`cancels ${contentType} at the first streamed byte beyond the limit`, async () => {
      let reads = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { reads += 1; controller.enqueue(new Uint8Array(reads === 1 ? 100 : 1)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      await expect(readMcpHttpResponse(new Response(body, {
        headers: { "content-type": contentType, "content-length": "invalid" },
      }), "request", { maxBytes: 100 })).rejects.toMatchObject({
        reason: "too_large", maxBytes: 100, responseBytes: 101,
      });
      expect(reads).toBe(2);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it(`reports UTF-8 byte size for buffered ${contentType} overflow`, async () => {
      const response = new Response(null, { headers: { "content-type": contentType } });
      response.text = async () => "\u00e9".repeat(51);
      await expect(readMcpHttpResponse(response, "request", { maxBytes: 100 })).rejects.toMatchObject({
        reason: "too_large", maxBytes: 100, responseBytes: 102,
      });
    });

    it(`accepts ${contentType} at exactly the byte limit`, async () => {
      const payload = { jsonrpc: "2.0", id: "request", result: {} };
      const json = JSON.stringify(payload);
      const body = contentType === "text/event-stream" ? `data: ${json}\n\n` : json;
      expect(await readMcpHttpResponse(new Response(body, {
        headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) },
      }), "request", { maxBytes: Buffer.byteLength(body) })).toEqual(payload);
    });
  }
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

    expect(requests.map(({ payload }) => payload.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[1]!.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[1]!.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
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
