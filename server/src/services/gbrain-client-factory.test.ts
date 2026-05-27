import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NullBearer,
  OAuthMintBearer,
  ServerGbrainCallError,
  StaticBearer,
  createServerGbrainClient,
  resolveBearerSource,
} from "./gbrain-client-factory.js";

const FAKE_CLIENTS_JSON = JSON.stringify({
  "agent-ceo": { client_id: "ceo-id", client_secret: "ceo-secret", name: "CEO" },
  "agent-empty": { name: "Missing creds" },
});

function mockTokenResponse(opts: { token: string; expiresIn?: number; status?: number }) {
  return new Response(JSON.stringify({ access_token: opts.token, expires_in: opts.expiresIn ?? 86400 }), {
    status: opts.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("StaticBearer", () => {
  it("always returns its constructor value", async () => {
    const src = new StaticBearer("static-token");
    expect(await src.getBearer()).toBe("static-token");
    expect(await src.getBearer()).toBe("static-token");
  });
});

describe("NullBearer", () => {
  it("always returns undefined", async () => {
    const src = new NullBearer();
    expect(await src.getBearer()).toBeUndefined();
  });
});

describe("OAuthMintBearer", () => {
  it("mints a token via /token using credentials from clients.json", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => mockTokenResponse({ token: "minted-abc" }));
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });

    const token = await src.getBearer();
    expect(token).toBe("minted-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify the request body shape (client_credentials grant).
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(init?.body as string);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("ceo-id");
    expect(params.get("client_secret")).toBe("ceo-secret");
  });

  it("caches the token until refreshLead before expiry, then re-mints", async () => {
    let nowMs = 1_000_000;
    let mintCount = 0;
    const fetchMock = vi.fn(async () => {
      mintCount += 1;
      return mockTokenResponse({ token: `minted-${mintCount}`, expiresIn: 3600 });
    });
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
      refreshLeadMs: 60_000,
      now: () => nowMs,
    });

    // First call mints.
    expect(await src.getBearer()).toBe("minted-1");
    // Second call within the cache window returns cached.
    nowMs += 1_000_000;
    expect(await src.getBearer()).toBe("minted-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Jump just past (expiresIn - refreshLead). 3600s - 60s = 3540s after first mint.
    nowMs = 1_000_000 + 3_540_001;
    expect(await src.getBearer()).toBe("minted-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refresh attempts onto a single in-flight mint", async () => {
    let resolveTokenCall: (resp: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveTokenCall = resolve;
        }),
    );
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });

    // Fire 5 concurrent calls before the in-flight mint resolves.
    const promises = [src.getBearer(), src.getBearer(), src.getBearer(), src.getBearer(), src.getBearer()];
    // Yield so the inflight promise is set on the OAuthMintBearer instance.
    await new Promise((r) => setTimeout(r, 0));
    resolveTokenCall(mockTokenResponse({ token: "single-mint" }));

    const results = await Promise.all(promises);
    expect(results).toEqual(["single-mint", "single-mint", "single-mint", "single-mint", "single-mint"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when clients.json is missing", async () => {
    const fetchMock = vi.fn();
    const src = new OAuthMintBearer({
      clientsFilePath: "/missing/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when clients.json is not valid JSON", async () => {
    const fetchMock = vi.fn();
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => "not json {{{",
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the agent has no client_id/secret in clients.json", async () => {
    const fetchMock = vi.fn();
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-empty",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the agent UUID is not present in clients.json", async () => {
    const fetchMock = vi.fn();
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-nonexistent",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when /token returns non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid_client", { status: 401 }));
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when /token response is missing access_token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
  });

  it("returns undefined when fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
  });

  it("does not cache a failed mint (retries on next call)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("oops", { status: 500 });
      return mockTokenResponse({ token: "recovered" });
    });
    const src = new OAuthMintBearer({
      clientsFilePath: "/fake/clients.json",
      agentId: "agent-ceo",
      tokenUrl: "http://gbrain/token",
      fetch: fetchMock as unknown as typeof fetch,
      readClientsFile: async () => FAKE_CLIENTS_JSON,
    });
    expect(await src.getBearer()).toBeUndefined();
    expect(await src.getBearer()).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveBearerSource", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN;
    delete process.env.PAPERCLIP_GBRAIN_OAUTH_CLIENTS_FILE;
    delete process.env.PAPERCLIP_GBRAIN_OAUTH_AGENT_ID;
    delete process.env.PAPERCLIP_GBRAIN_MCP_TOKEN_URL;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN;
    delete process.env.PAPERCLIP_GBRAIN_OAUTH_CLIENTS_FILE;
    delete process.env.PAPERCLIP_GBRAIN_OAUTH_AGENT_ID;
    delete process.env.PAPERCLIP_GBRAIN_MCP_TOKEN_URL;
  });

  it("returns the explicit bearerSource when provided", () => {
    const explicit = new NullBearer();
    expect(resolveBearerSource({ bearerSource: explicit })).toBe(explicit);
  });

  it("wraps opts.bearerToken in a StaticBearer when no source is given", async () => {
    const src = resolveBearerSource({ bearerToken: "opts-token" });
    expect(await src.getBearer()).toBe("opts-token");
  });

  it("falls back to PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN env var", async () => {
    process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN = "env-token";
    const src = resolveBearerSource();
    expect(await src.getBearer()).toBe("env-token");
  });

  it("opts.bearerToken takes precedence over the env var", async () => {
    process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN = "env-token";
    const src = resolveBearerSource({ bearerToken: "opts-token" });
    expect(await src.getBearer()).toBe("opts-token");
  });

  it("defaults to an OAuthMintBearer when no static value is set", () => {
    const src = resolveBearerSource();
    expect(src).toBeInstanceOf(OAuthMintBearer);
  });
});

describe("createServerGbrainClient (integration smoke)", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_GBRAIN_MCP_BEARER_TOKEN;
  });

  it("attaches a freshly-minted Authorization header on call()", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/token")) {
        return mockTokenResponse({ token: "smoke-token" });
      }
      // /mcp call — assert the bearer landed.
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBe("Bearer smoke-token");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createServerGbrainClient({
      url: "http://gbrain/mcp",
      bearerSource: new OAuthMintBearer({
        clientsFilePath: "/fake/clients.json",
        agentId: "agent-ceo",
        tokenUrl: "http://gbrain/token",
        fetch: fetchMock as unknown as typeof fetch,
        readClientsFile: async () => FAKE_CLIENTS_JSON,
      }),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.call("get_page", { slug: "x" });
    expect(result).toEqual({ ok: true });
    // 1 /token + 1 /mcp = 2 fetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends no Authorization header when the bearer source returns undefined", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBeUndefined();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: '"ok"' }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createServerGbrainClient({
      url: "http://gbrain/mcp",
      bearerSource: new NullBearer(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.call("get_page", { slug: "x" });
    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HttpServerGbrainClient.call isError handling (BLO-6979)", () => {
  function mcpResponse(body: object) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function clientWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
    return createServerGbrainClient({
      url: "http://gbrain/mcp",
      bearerSource: new NullBearer(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  }

  it("throws ServerGbrainCallError with errorCode='page_not_found' when the upstream OperationError says so", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "page_not_found",
                message: "Page not found: sweep-wake-frames/blockcast/ceo/blo-1",
                suggestion: "Page may be soft-deleted; pass include_deleted: true to verify",
              }),
            },
          ],
          isError: true,
        },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const err = await client.call("get_page", { slug: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerGbrainCallError);
    expect((err as ServerGbrainCallError).errorCode).toBe("page_not_found");
    expect((err as ServerGbrainCallError).message).toMatch(/get_page.*page_not_found.*Page not found/);
  });

  it("throws ServerGbrainCallError with errorCode='invalid_params' for slug-validation failures", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "invalid_params",
                message: "Invalid page_slug: Foo/BAR (allowed: alphanumeric, ...)",
              }),
            },
          ],
          isError: true,
        },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const err = await client.call("put_page", { slug: "Foo/BAR", content: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerGbrainCallError);
    expect((err as ServerGbrainCallError).errorCode).toBe("invalid_params");
  });

  it("falls back to errorCode='internal_error' when content[0].text is missing", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [], isError: true },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const err = await client.call("get_page", { slug: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerGbrainCallError);
    expect((err as ServerGbrainCallError).errorCode).toBe("internal_error");
    expect((err as ServerGbrainCallError).message).toMatch(/<no error payload>/);
  });

  it("falls back to errorCode='internal_error' when content[0].text is not JSON", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "boom: not json" }], isError: true },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const err = await client.call("get_page", { slug: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerGbrainCallError);
    expect((err as ServerGbrainCallError).errorCode).toBe("internal_error");
    expect((err as ServerGbrainCallError).message).toMatch(/boom: not json/);
  });

  it("returns the parsed result when isError is absent", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ slug: "x", body: "ok" }) }] },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const result = await client.call<{ slug: string; body: string }>("get_page", { slug: "x" });
    expect(result).toEqual({ slug: "x", body: "ok" });
  });

  it("returns the parsed result when isError is explicitly false", async () => {
    const fetchMock = vi.fn(async () =>
      mcpResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ slug: "x" }) }],
          isError: false,
        },
      }),
    );
    const client = clientWithFetch(fetchMock);
    const result = await client.call<{ slug: string }>("get_page", { slug: "x" });
    expect(result).toEqual({ slug: "x" });
  });
});
