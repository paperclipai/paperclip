import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ghFetch } from "../services/github-fetch.ts";

const TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Capture what ghFetch would send, without making a request. */
function captureFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  });
  return calls;
}

function authHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

describe("ghFetch GitHub authentication", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOKEN_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TOKEN_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  it("sends no Authorization header when no token is configured", async () => {
    const calls = captureFetch();
    await ghFetch("https://api.github.com/repos/owner/repo");
    expect(authHeader(calls[0]?.init)).toBeNull();
  });

  it("sends the token to the GitHub API host", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const calls = captureFetch();
    await ghFetch("https://api.github.com/repos/owner/repo");
    expect(authHeader(calls[0]?.init)).toBe("Bearer test-token");
  });

  it("sends the token to the raw content host", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const calls = captureFetch();
    await ghFetch("https://raw.githubusercontent.com/owner/repo/main/SKILL.md");
    expect(authHeader(calls[0]?.init)).toBe("Bearer test-token");
  });

  it("does not send the token to a GitHub Enterprise host", async () => {
    // Enterprise hostnames come from an operator-supplied import URL. A token
    // configured for github.com must not travel to a host named in a URL.
    process.env.GITHUB_TOKEN = "test-token";
    const calls = captureFetch();
    await ghFetch("https://ghe.example.com/api/v3/repos/owner/repo");
    expect(authHeader(calls[0]?.init)).toBeNull();
  });

  it("does not overwrite an Authorization header the caller already set", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const calls = captureFetch();
    await ghFetch("https://api.github.com/repos/owner/repo", {
      headers: { authorization: "Bearer caller-token" },
    });
    expect(authHeader(calls[0]?.init)).toBe("Bearer caller-token");
  });

  it("preserves other headers", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const calls = captureFetch();
    await ghFetch("https://api.github.com/repos/owner/repo", {
      headers: { accept: "application/vnd.github+json" },
    });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("accepts the alternate token variable names", async () => {
    process.env.PAPERCLIP_GITHUB_TOKEN = "alt-token";
    const calls = captureFetch();
    await ghFetch("https://api.github.com/repos/owner/repo");
    expect(authHeader(calls[0]?.init)).toBe("Bearer alt-token");
  });
});
