import { describe, expect, it, vi } from "vitest";
import { forgetMcpHttpSessions, getMcpHttpSession, initializeMcpHttpSession, McpHttpInitializationError, readMcpHttpResponse } from "../services/mcp-http.js";

const encoder = new TextEncoder();
function stream(chunks: string[], close = true) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); if (close) controller.close(); }, cancel }), { headers: { "content-type": "text/event-stream" } });
  return { response, cancel };
}
function event(message: unknown) { return `data: ${JSON.stringify(message)}\r\n\r\n`; }

describe("remote connector Streamable HTTP", () => {
  it("matches the requested ID after progress and unrelated messages without waiting for stream closure", async () => {
    const fixture = stream([event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }), event({ jsonrpc: "2.0", id: "other", result: {} }), event({ jsonrpc: "2.0", id: "call", result: { content: [] } })], false);
    expect(await readMcpHttpResponse(fixture.response, "call")).toEqual({ jsonrpc: "2.0", id: "call", result: { content: [] } });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
  it("decodes split CRLF and UTF-8 chunks", async () => {
    const data = event({ id: 7, result: { text: "café" } });
    expect(await readMcpHttpResponse(stream([...data]).response, 7)).toMatchObject({ result: { text: "café" } });
  });
  it("rejects an unrelated JSON result and bounds streamed responses", async () => {
    await expect(readMcpHttpResponse(Response.json({ id: "wrong", result: {} }), "call")).rejects.toThrow("message ID");
    await expect(readMcpHttpResponse(stream([event({ id: 1, result: "too much" })]).response, 1, { maxBytes: 8 })).rejects.toThrow("size limit");
  });
  it("applies matching, parse errors, and size limits to buffered HTTP transports", async () => {
    const buffered = (body: string) => ({ headers: new Headers(), text: async () => body }) as Response;
    expect(await readMcpHttpResponse(buffered('{"id":"call","result":{}}'), "call")).toMatchObject({ id: "call" });
    await expect(readMcpHttpResponse(buffered('{"id":"other","result":{}}'), "call")).rejects.toMatchObject({ reason: "malformed_response" });
    await expect(readMcpHttpResponse(buffered("not json"), "call")).rejects.toMatchObject({ reason: "invalid_json" });
    await expect(readMcpHttpResponse(buffered("too large"), "call", { maxBytes: 2 })).rejects.toMatchObject({ reason: "too_large" });
  });
  it("delivers server requests before the matching response", async () => {
    const onRequest = vi.fn(async () => {});
    const request = { jsonrpc: "2.0", id: "auth", method: "elicitation/create", params: { mode: "url", url: "https://example.com/auth", elicitationId: "consent" } };
    await readMcpHttpResponse(stream([event(request), event({ id: "call", result: {} })]).response, "call", { onRequest });
    expect(onRequest).toHaveBeenCalledWith(request);
  });
  it("preserves an initialization authentication challenge for OAuth discovery", async () => {
    const response = new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"' } });
    try { await initializeMcpHttpSession({ requestId: "a", send: async () => response }); throw new Error("Expected challenge"); }
    catch (error) { expect(error).toBeInstanceOf(McpHttpInitializationError); expect((error as McpHttpInitializationError).response).toBe(response); }
  });
  it("initializes once per connection and identity and resets after revocation", async () => {
    let count = 0;
    const send = vi.fn(async (init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") { count++; return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "Mcp-Session-Id": `session-${count}` } }); }
      expect(body.method).toBe("notifications/initialized");
      return new Response(null, { status: 202 });
    });
    const input = { send, requestId: "a", scope: "connection-a:grant-a", headers: { Authorization: "Bearer secret-a" } };
    const [a, repeated] = await Promise.all([getMcpHttpSession(input), getMcpHttpSession(input)]);
    expect(a).toEqual(repeated);
    expect((await getMcpHttpSession(input))["Mcp-Session-Id"]).toBe("session-1");
    expect((await getMcpHttpSession({ ...input, scope: "connection-b:grant-a" }))["Mcp-Session-Id"]).toBe("session-2");
    expect((await getMcpHttpSession({ ...input, scope: "connection-a:grant-b" }))["Mcp-Session-Id"]).toBe("session-3");
    expect((await getMcpHttpSession({ ...input, headers: { Authorization: "Bearer rotated" } }))["Mcp-Session-Id"]).toBe("session-4");
    forgetMcpHttpSessions("connection-a");
    expect((await getMcpHttpSession(input))["Mcp-Session-Id"]).toBe("session-5");
    expect(count).toBe(5);
  });
  it("does not resurrect an in-flight session after disconnect", async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const send = async (init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        await gate;
        return Response.json({ id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": "revoked" } });
      }
      return new Response(null, { status: 202 });
    };
    const pending = getMcpHttpSession({ send, requestId: "revoking", scope: "revoking-connection:agent" });
    forgetMcpHttpSessions("revoking-connection");
    finish!();
    await expect(pending).rejects.toThrow("connection changed");
  });
});
