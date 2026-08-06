import { describe, expect, it, vi } from "vitest";
import {
  closeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  mcpHttpRequestHeaders,
  openMcpHttpSession,
  parseMcpHttpResponseBody,
  withMcpSessionHeader,
} from "../services/mcp-http.js";

function jsonResponse(
  payload: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: opts.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

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

describe("openMcpHttpSession", () => {
  it("returns the session id and sends notifications/initialized when the server advertises one", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "initialize") {
        expect(init?.redirect).toBe("manual");
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: "paperclip-mcp-initialize",
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "sess", version: "1" } },
          },
          { headers: { "mcp-session-id": "sess-abc" } },
        );
      }
      if (body.method === "notifications/initialized") {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected method ${body.method}`);
    });

    const session = await openMcpHttpSession({
      endpoint: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer x" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(session).toEqual({ sessionId: "sess-abc", protocolVersion: "2025-03-26" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const initBody = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(initBody).toMatchObject({
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "paperclip", version: "0.3.1" },
      },
    });
    const notifyInit = fetchImpl.mock.calls[1]![1];
    expect(JSON.parse(String(notifyInit?.body))).toMatchObject({
      method: "notifications/initialized",
      params: {},
    });
    expect(notifyInit?.body).not.toContain('"id"');
    expect(notifyInit?.headers).toEqual(
      expect.objectContaining({
        "mcp-session-id": "sess-abc",
        "mcp-protocol-version": "2025-03-26",
        accept: "application/json, text/event-stream",
      }),
    );
  });

  it("returns null sessionId and skips notifications/initialized when no session header is present", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        jsonrpc: "2.0",
        id: "paperclip-mcp-initialize",
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      }),
    );

    const session = await openMcpHttpSession({
      endpoint: "https://mcp.example/mcp",
      headers: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(session).toEqual({ sessionId: null, protocolVersion: "2025-03-26" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).method).toBe("initialize");
  });

  it("fail-soft: HTTP 500 on initialize returns null session without throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));

    await expect(
      openMcpHttpSession({
        endpoint: "https://mcp.example/mcp",
        headers: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ sessionId: null, protocolVersion: null });
  });

  it("fail-soft: 3xx redirect on initialize returns null session without following", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      }),
    );

    await expect(
      openMcpHttpSession({
        endpoint: "https://mcp.example/mcp",
        headers: { Authorization: "Bearer secret" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ sessionId: null, protocolVersion: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).toEqual(expect.objectContaining({ redirect: "manual" }));
  });

  it("fail-soft: network errors on initialize return null session without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      openMcpHttpSession({
        endpoint: "https://mcp.example/mcp",
        headers: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ sessionId: null, protocolVersion: null });
  });

  it("parses an SSE-framed initialize response via parseMcpHttpResponseBody", async () => {
    const payload = {
      jsonrpc: "2.0",
      id: "paperclip-mcp-initialize",
      result: { protocolVersion: "2025-03-26", capabilities: {} },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "sse-sess",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const session = await openMcpHttpSession({
      endpoint: "https://mcp.example/mcp",
      headers: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(session).toEqual({ sessionId: "sse-sess", protocolVersion: "2025-03-26" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("closeMcpHttpSession", () => {
  it("DELETEs with mcp-session-id and never throws", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      closeMcpHttpSession({
        endpoint: "https://mcp.example/mcp",
        headers: { Authorization: "Bearer x" },
        sessionId: "sess-abc",
        protocolVersion: "2025-03-26",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mcp.example/mcp",
      expect.objectContaining({
        method: "DELETE",
        redirect: "manual",
        headers: expect.objectContaining({
          "mcp-session-id": "sess-abc",
          "mcp-protocol-version": "2025-03-26",
        }),
      }),
    );
  });

  it("swallows network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      closeMcpHttpSession({
        endpoint: "https://mcp.example/mcp",
        headers: {},
        sessionId: "sess-abc",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("withMcpSessionHeader", () => {
  it("returns a copy without a session key when sessionId is null", () => {
    const original = { Authorization: "Bearer x" };
    const next = withMcpSessionHeader(original, null);
    expect(next).toEqual({ Authorization: "Bearer x" });
    expect(next).not.toHaveProperty("mcp-session-id");
    expect(next).not.toBe(original);
    original.Authorization = "mutated";
    expect(next.Authorization).toBe("Bearer x");
  });

  it("adds mcp-session-id and optional protocol version without mutating the original", () => {
    const original = { Authorization: "Bearer x" };
    const next = withMcpSessionHeader(original, "abc", "2025-03-26");
    expect(next).toEqual({
      Authorization: "Bearer x",
      "mcp-session-id": "abc",
      "mcp-protocol-version": "2025-03-26",
    });
    expect(original).toEqual({ Authorization: "Bearer x" });
    expect(next).not.toBe(original);
  });
});
