import { describe, it, expect, vi, beforeEach } from "vitest";
import { GbrainClient, GbrainCallError } from "../gbrain-client.js";

describe("GbrainClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GbrainClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new GbrainClient({
      url: "http://gbrain.test/gbrain",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000,
    });
  });

  it("posts a JSON-RPC tools/call envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("put_page", { slug: "issue/BLO-1", content: "x" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gbrain.test/gbrain");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["accept"]).toContain("application/json");

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "put_page", arguments: { slug: "issue/BLO-1", content: "x" } },
    });
    expect(typeof body.id).toBe("number");

    expect(out).toEqual({ ok: true });
  });

  it("throws GbrainCallError on JSON-RPC error response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Tool not found" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(client.call("nonexistent", {})).rejects.toBeInstanceOf(
      GbrainCallError,
    );
  });

  it("aborts after timeoutMs and throws GbrainCallError", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const start = Date.now();
    await expect(client.call("slow", {})).rejects.toBeInstanceOf(GbrainCallError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("returns the parsed text payload of the first content block", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "{\"slug\":\"issue/X\",\"created\":true}" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("put_page", {});
    expect(out).toEqual({ slug: "issue/X", created: true });
  });

  it("returns raw result when no content[0].text JSON is present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "image", data: "..." }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("get_image", {});
    expect(out).toEqual({ content: [{ type: "image", data: "..." }] });
  });

  it("parses SSE-wrapped JSON-RPC responses", async () => {
    const sse =
      `event: message\n` +
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{\"slug\":\"issue/X\"}" }] },
      })}\n\n`;
    fetchMock.mockResolvedValueOnce(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );

    const out = await client.call("get_page", { slug: "issue/X" });
    expect(out).toEqual({ slug: "issue/X" });
  });

  it("returns null when result.isError is true (e.g. tool-level not-found)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "{\"error\":\"page_not_found\"}" }],
            isError: true,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("get_page", { slug: "issue/missing" });
    expect(out).toBeNull();
  });

  it("attaches Authorization: Bearer when authProvider is set", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }] },
      }), { headers: { "content-type": "application/json" } }),
    );
    const authProvider = vi.fn(async () => "tok-abc");
    const authed = new GbrainClient({
      url: "http://gbrain.test/mcp",
      fetch: fetchMock as unknown as typeof fetch,
      authProvider,
    });
    await authed.call("put_page", {});
    expect(authProvider).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-abc");
  });

  it("does not send an anonymous request when authProvider cannot issue a token", async () => {
    const authed = new GbrainClient({
      url: "http://gbrain.test/mcp",
      fetch: fetchMock as unknown as typeof fetch,
      authProvider: async () => {
        throw new Error("gbrain OAuth: no client configured for agentId agent-1");
      },
    });

    await expect(authed.call("put_page", {})).rejects.toThrow(
      "gbrain OAuth: no client configured for agentId agent-1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on 401 invokes onAuthFailure and retries once with a fresh token", async () => {
    // First call returns 401, second returns success.
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
      }), { headers: { "content-type": "application/json" } }));

    let tokenIdx = 0;
    const tokens = ["stale-tok", "fresh-tok"];
    const authProvider = vi.fn(async () => tokens[tokenIdx++]);
    const onAuthFailure = vi.fn();

    const authed = new GbrainClient({
      url: "http://gbrain.test/mcp",
      fetch: fetchMock as unknown as typeof fetch,
      authProvider,
      onAuthFailure,
      authRetryBackoffMs: 0,
    });
    const out = await authed.call("put_page", {});
    expect(out).toEqual({ ok: true });
    expect(authProvider).toHaveBeenCalledTimes(2);
    expect(onAuthFailure).toHaveBeenCalledOnce();
    // Verify the retry used the fresh token.
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe("Bearer stale-tok");
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).authorization).toBe("Bearer fresh-tok");
  });

  it("waits briefly before retrying after a 401", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
        }), { headers: { "content-type": "application/json" } }));

      const authProvider = vi.fn(async () => "tok");
      const onAuthFailure = vi.fn();
      const authed = new GbrainClient({
        url: "http://gbrain.test/mcp",
        fetch: fetchMock as unknown as typeof fetch,
        authProvider,
        onAuthFailure,
        authRetryBackoffMs: 250,
      });

      const call = authed.call("put_page", {});
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onAuthFailure).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(call).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a 401 a second time (gives up after one rotation)", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const authProvider = vi.fn(async () => "tok");
    const authed = new GbrainClient({
      url: "http://gbrain.test/mcp",
      fetch: fetchMock as unknown as typeof fetch,
      authProvider,
      authRetryBackoffMs: 0,
    });
    await expect(authed.call("put_page", {})).rejects.toBeInstanceOf(GbrainCallError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
