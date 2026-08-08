import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";

const mockResponse = new Response("{}", { status: 200 });

describe("ghFetch", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchSpy);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends no Authorization header when GITHUB_TOKEN is unset", async () => {
    await ghFetch("https://api.github.com/repos/foo/bar");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("injects Authorization header for api.github.com when GITHUB_TOKEN is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    await ghFetch("https://api.github.com/repos/foo/bar");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("token tok-abc");
  });

  it("injects Authorization header for raw.githubusercontent.com", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    await ghFetch("https://raw.githubusercontent.com/foo/bar/main/README.md");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("token tok-abc");
  });

  it("does NOT inject Authorization header for non-GitHub hosts", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    await ghFetch("https://api.github.com/repos/foo/bar");
    // verify it does inject for GitHub
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toBeDefined();

    fetchSpy.mockClear();
    // now a non-GitHub host should get no token
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    await ghFetch("https://api.github.com/repos/foo/bar").catch(() => {});
    // reset and test non-GitHub
    fetchSpy.mockClear();
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    // Override fetch to succeed for this URL
    fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchSpy);
    // Manually test isKnownGitHubHost indirectly by checking the absence of header
    // We test with a URL that would not match any GitHub host pattern
    // (ghFetch itself would throw unprocessable on network error, so we rely on mock)
    await ghFetch("https://not-github.example.com/data");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("caller-supplied Authorization header wins over injected token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-abc");
    await ghFetch("https://api.github.com/repos/foo/bar", {
      headers: { Authorization: "token caller-supplied" },
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("token caller-supplied");
  });

  it("injects Authorization header for a configured GITHUB_HOST GHE instance", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok-ghe");
    vi.stubEnv("GITHUB_HOST", "github.mycompany.com");
    await ghFetch("https://github.mycompany.com/api/v3/repos/foo/bar");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("token tok-ghe");
  });
});

describe("gitHubApiBase", () => {
  it("returns api.github.com for github.com", () => {
    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
  });
  it("returns /api/v3 path for a GHE hostname", () => {
    expect(gitHubApiBase("github.mycompany.com")).toBe("https://github.mycompany.com/api/v3");
  });
});

describe("resolveRawGitHubUrl", () => {
  it("uses raw.githubusercontent.com for github.com", () => {
    expect(resolveRawGitHubUrl("github.com", "owner", "repo", "main", "README.md")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/README.md"
    );
  });
  it("uses /raw/ path for a GHE hostname", () => {
    expect(resolveRawGitHubUrl("github.mycompany.com", "owner", "repo", "main", "README.md")).toBe(
      "https://github.mycompany.com/raw/owner/repo/main/README.md"
    );
  });
  it("strips leading slashes from filePath", () => {
    expect(resolveRawGitHubUrl("github.com", "owner", "repo", "main", "/src/index.ts")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/src/index.ts"
    );
  });
});
