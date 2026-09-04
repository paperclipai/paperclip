import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch } from "./github-fetch.js";

const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

function restoreEnv(name: "GITHUB_TOKEN" | "GH_TOKEN", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("GITHUB_TOKEN", originalGitHubToken);
  restoreEnv("GH_TOKEN", originalGhToken);
  vi.unstubAllGlobals();
});

describe("ghFetch", () => {
  it("adds GITHUB_TOKEN authentication to api.github.com requests", async () => {
    process.env.GITHUB_TOKEN = "github-test-token";
    delete process.env.GH_TOKEN;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch("https://api.github.com/repos/example/repo", {
      headers: { Accept: "application/vnd.github+json" },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer github-test-token");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
  });

  it("does not overwrite an explicit Authorization header", async () => {
    process.env.GITHUB_TOKEN = "github-test-token";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch("https://api.github.com/repos/example/repo", {
      headers: { Authorization: "Bearer caller-token" },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer caller-token");
  });

  it("never sends the GitHub API token to non-api.github.com hosts", async () => {
    process.env.GITHUB_TOKEN = "github-test-token";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch("https://raw.githubusercontent.com/example/repo/main/SKILL.md");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is unavailable", async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-test-token";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch("https://api.github.com/repos/example/repo");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gh-test-token");
  });
});
