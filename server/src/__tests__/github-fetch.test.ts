import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghFetch } from "../services/github-fetch.js";

function makeOkResponse(): Response {
  return new Response("ok", { status: 200 });
}

function getInitForCall(call: unknown): RequestInit | undefined {
  const args = call as [unknown, RequestInit | undefined];
  return args[1];
}

function getAuthHeader(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null;
  const headers = new Headers(init.headers);
  return headers.get("Authorization");
}

describe("ghFetch GitHub authentication", () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  const originalGithubHosts = process.env.PAPERCLIP_GITHUB_HOSTS;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.PAPERCLIP_GITHUB_HOSTS;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeOkResponse()));
  });

  afterEach(() => {
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    if (originalGithubHosts === undefined) delete process.env.PAPERCLIP_GITHUB_HOSTS;
    else process.env.PAPERCLIP_GITHUB_HOSTS = originalGithubHosts;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not attach an Authorization header when no token is set", async () => {
    await ghFetch("https://api.github.com/repos/octocat/hello-world");

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe("https://api.github.com/repos/octocat/hello-world");
    expect(getAuthHeader(getInitForCall(call))).toBeNull();
  });

  it("attaches Authorization: Bearer header for api.github.com when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_value";

    await ghFetch("https://api.github.com/repos/octocat/hello-world");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_test_token_value");
  });

  it("attaches Authorization header for raw.githubusercontent.com requests", async () => {
    process.env.GITHUB_TOKEN = "ghp_raw_token";

    await ghFetch("https://raw.githubusercontent.com/octocat/hello/main/README.md");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_raw_token");
  });

  it("attaches Authorization header for an operator-configured GitHub Enterprise host", async () => {
    process.env.GITHUB_TOKEN = "ghp_ghe_token";
    process.env.PAPERCLIP_GITHUB_HOSTS = "github.example.com";

    await ghFetch("https://github.example.com/api/v3/repos/acme/widgets");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_ghe_token");
  });

  it("supports multiple GHE hosts via PAPERCLIP_GITHUB_HOSTS comma-separated list", async () => {
    process.env.GITHUB_TOKEN = "ghp_multi";
    process.env.PAPERCLIP_GITHUB_HOSTS = "ghe-east.example.com, ghe-west.example.com";

    await ghFetch("https://ghe-west.example.com/api/v3/user");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_multi");
  });

  it("does not attach Authorization header to a path-only GHE-shaped URL on an unconfigured host", async () => {
    // Defense in depth: an attacker-controlled URL whose path looks like
    // `/api/v3/...` must NOT receive the token unless the host is explicitly
    // allowlisted via PAPERCLIP_GITHUB_HOSTS.
    process.env.GITHUB_TOKEN = "ghp_test_token_value";

    await ghFetch("https://attacker.example.com/api/v3/collect");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBeNull();
  });

  it("does not attach Authorization header for unrecognized hosts even when token is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_value";

    await ghFetch("https://example.com/some/resource");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBeNull();
  });

  it("does not attach Authorization header to a configured GHE host that does not match the URL", async () => {
    // Configured a different GHE host — example.org should NOT get the token.
    process.env.GITHUB_TOKEN = "ghp_test_token_value";
    process.env.PAPERCLIP_GITHUB_HOSTS = "github.example.com";

    await ghFetch("https://example.org/api/v3/whatever");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBeNull();
  });

  it("does not overwrite a caller-supplied Authorization header", async () => {
    process.env.GITHUB_TOKEN = "ghp_env_token";

    await ghFetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer caller-supplied-token" },
    });

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer caller-supplied-token");
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is unset", async () => {
    process.env.GH_TOKEN = "ghp_gh_fallback";

    await ghFetch("https://api.github.com/repos/octocat/hello-world");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_gh_fallback");
  });

  it("prefers GITHUB_TOKEN over GH_TOKEN when both are set", async () => {
    process.env.GITHUB_TOKEN = "ghp_primary";
    process.env.GH_TOKEN = "ghp_fallback";

    await ghFetch("https://api.github.com/repos/octocat/hello-world");

    const init = getInitForCall(vi.mocked(fetch).mock.calls[0]);
    expect(getAuthHeader(init)).toBe("Bearer ghp_primary");
  });
});
