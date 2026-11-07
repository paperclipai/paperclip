import { describe, expect, it } from "vitest";
import { readGitHubRepositoryCatalogFailure } from "../services/tool-access/github-repository-catalog-failure.js";

describe("GitHub repository discovery failure", () => {
  const now = Date.UTC(2026, 0, 1);
  it.each([401, 403, 404, 422])("keeps HTTP%s authorization failures terminal", status => {
    expect(readGitHubRepositoryCatalogFailure(new Response(null, { status }), now)).toBeNull();
  });
  it.each([408, 425, 429, 500, 502, 503, 504])("recognizes HTTP%s availability without exposing provider content", status => {
    expect(readGitHubRepositoryCatalogFailure(new Response("private provider detail", { status }), now))
      .toMatchObject({ code: "repository_catalog_unavailable", retryAt: undefined });
  });
  it("respects both exhausted quota deadlines", () => {
    const response = new Response(null, { status: 403, headers: {
      "x-ratelimit-remaining": "0", "retry-after": "5", "x-ratelimit-reset": String((now + 60_000) / 1000),
    } });
    expect(readGitHubRepositoryCatalogFailure(response, now)?.retryAt).toBe(now + 60_000);
  });
  it("bounds the provider deadline and ignores malformed reset headers", () => {
    expect(readGitHubRepositoryCatalogFailure(new Response(null, { status: 429,
      headers: { "retry-after": "999999999" } }), now)?.retryAt).toBe(now + 24 * 3600_000);
    expect(readGitHubRepositoryCatalogFailure(new Response(null, { status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-date" } }), now)?.retryAt).toBeUndefined();
  });
});
