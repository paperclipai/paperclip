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
});
