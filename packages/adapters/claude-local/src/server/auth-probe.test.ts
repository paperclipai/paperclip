import { describe, expect, it } from "vitest";
import { isAdapterUnhealthy, probeClaudeAuth } from "./auth-probe.js";

function makeResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("probeClaudeAuth", () => {
  it("returns ok without a network call when Bedrock is configured", async () => {
    let called = false;
    const result = await probeClaudeAuth({
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      fetchImpl: async () => {
        called = true;
        return makeResponse(200);
      },
      readToken: async () => null,
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("bedrock");
    expect(called).toBe(false);
  });

  it("returns no_credentials when nothing is configured", async () => {
    const result = await probeClaudeAuth({
      env: {},
      fetchImpl: async () => makeResponse(200),
      readToken: async () => null,
    });
    expect(result.status).toBe("no_credentials");
    expect(result.source).toBe("none");
    expect(isAdapterUnhealthy(result)).toBe(true);
  });

  it("probes via API key when ANTHROPIC_API_KEY is set and returns ok on 200", async () => {
    let probedUrl = "";
    let sentApiKey = "";
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-test-key" },
      fetchImpl: async (url, init) => {
        probedUrl = url;
        const headers = (init.headers ?? {}) as Record<string, string>;
        sentApiKey = headers["x-api-key"] ?? "";
        return makeResponse(200, { data: [] }, { "request-id": "req_abc" });
      },
      readToken: async () => "should-not-be-read",
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("api_key");
    expect(result.httpStatus).toBe(200);
    expect(result.requestId).toBe("req_abc");
    expect(probedUrl).toContain("/v1/models");
    expect(sentApiKey).toBe("sk-test-key");
    expect(isAdapterUnhealthy(result)).toBe(false);
  });

  it("returns unauthenticated on 401 from API-key probe and surfaces request id", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-bad" },
      fetchImpl: async () =>
        makeResponse(401, { error: { type: "authentication_error" } }, { "request-id": "req_401" }),
      readToken: async () => null,
    });
    expect(result.status).toBe("unauthenticated");
    expect(result.source).toBe("api_key");
    expect(result.httpStatus).toBe(401);
    expect(result.requestId).toBe("req_401");
    expect(result.detail).toContain("401");
    expect(isAdapterUnhealthy(result)).toBe(true);
  });

  it("returns unauthenticated on 403 (treated same as 401)", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-bad" },
      fetchImpl: async () => makeResponse(403),
      readToken: async () => null,
    });
    expect(result.status).toBe("unauthenticated");
    expect(isAdapterUnhealthy(result)).toBe(true);
  });

  it("returns rate_limited on 429 (NOT unhealthy — recoverable)", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl: async () => makeResponse(429),
      readToken: async () => null,
    });
    expect(result.status).toBe("rate_limited");
    expect(result.httpStatus).toBe(429);
    expect(isAdapterUnhealthy(result)).toBe(false);
  });

  it("returns transient_error on 5xx", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl: async () => makeResponse(503),
      readToken: async () => null,
    });
    expect(result.status).toBe("transient_error");
    expect(result.httpStatus).toBe(503);
    expect(isAdapterUnhealthy(result)).toBe(false);
  });

  it("returns transient_error when fetch throws (network error / timeout)", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl: async () => {
        throw new Error("network unreachable");
      },
      readToken: async () => null,
    });
    expect(result.status).toBe("transient_error");
    expect(result.source).toBe("api_key");
    expect(result.detail).toContain("network unreachable");
    expect(isAdapterUnhealthy(result)).toBe(false);
  });

  it("falls back to OAuth probe when API key is absent and a token is available", async () => {
    let probedUrl = "";
    let sentAuth = "";
    const result = await probeClaudeAuth({
      env: {},
      fetchImpl: async (url, init) => {
        probedUrl = url;
        const headers = (init.headers ?? {}) as Record<string, string>;
        sentAuth = headers.Authorization ?? "";
        return makeResponse(200, { five_hour: { utilization: 0.5 } });
      },
      readToken: async () => "oauth-token-xyz",
    });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("oauth");
    expect(probedUrl).toContain("/api/oauth/usage");
    expect(sentAuth).toBe("Bearer oauth-token-xyz");
  });

  it("returns unauthenticated on 401 from OAuth probe", async () => {
    const result = await probeClaudeAuth({
      env: {},
      fetchImpl: async () => makeResponse(401),
      readToken: async () => "expired-token",
    });
    expect(result.status).toBe("unauthenticated");
    expect(result.source).toBe("oauth");
    expect(isAdapterUnhealthy(result)).toBe(true);
  });

  it("treats whitespace-only API key as absent (falls through to OAuth)", async () => {
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: "   " },
      fetchImpl: async () => makeResponse(200),
      readToken: async () => "fallback-oauth",
    });
    expect(result.source).toBe("oauth");
  });

  it("never returns the credential in any field", async () => {
    const apiKey = "sk-supersecret-shouldnotleak";
    const result = await probeClaudeAuth({
      env: { ANTHROPIC_API_KEY: apiKey },
      fetchImpl: async () => makeResponse(401, { error: apiKey }, { "request-id": "req_x" }),
      readToken: async () => null,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(apiKey);
  });
});

describe("isAdapterUnhealthy", () => {
  it("treats unauthenticated and no_credentials as unhealthy", () => {
    const probedAt = new Date().toISOString();
    expect(isAdapterUnhealthy({ status: "unauthenticated", source: "api_key", probedAt })).toBe(true);
    expect(isAdapterUnhealthy({ status: "no_credentials", source: "none", probedAt })).toBe(true);
  });

  it("treats ok / rate_limited / transient_error as NOT unhealthy", () => {
    const probedAt = new Date().toISOString();
    expect(isAdapterUnhealthy({ status: "ok", source: "api_key", probedAt })).toBe(false);
    expect(isAdapterUnhealthy({ status: "rate_limited", source: "api_key", probedAt })).toBe(false);
    expect(isAdapterUnhealthy({ status: "transient_error", source: "api_key", probedAt })).toBe(false);
  });
});
