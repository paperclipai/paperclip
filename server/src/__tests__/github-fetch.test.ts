import { afterEach, describe, expect, it, vi } from "vitest";
import { gitHubApiBase, ghFetch, resolveRawGitHubUrl } from "../services/github-fetch.js";

describe("gitHubApiBase", () => {
  it("returns the public GitHub API base for github.com", () => {
    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
  });

  it("returns the public GitHub API base for www.github.com", () => {
    expect(gitHubApiBase("www.github.com")).toBe("https://api.github.com");
  });

  it("is case-insensitive for the GitHub.com hostname", () => {
    expect(gitHubApiBase("GitHub.com")).toBe("https://api.github.com");
    expect(gitHubApiBase("GITHUB.COM")).toBe("https://api.github.com");
  });

  it("returns the GitHub Enterprise v3 API base for custom hostnames", () => {
    expect(gitHubApiBase("github.mycompany.com")).toBe(
      "https://github.mycompany.com/api/v3",
    );
    expect(gitHubApiBase("ghe.example.org")).toBe("https://ghe.example.org/api/v3");
  });
});

describe("resolveRawGitHubUrl", () => {
  it("returns a raw.githubusercontent.com URL for github.com", () => {
    const url = resolveRawGitHubUrl("github.com", "owner", "repo", "main", "path/to/file.ts");
    expect(url).toBe("https://raw.githubusercontent.com/owner/repo/main/path/to/file.ts");
  });

  it("strips a leading slash from the file path", () => {
    const url = resolveRawGitHubUrl("github.com", "owner", "repo", "main", "/path/file.ts");
    expect(url).toBe("https://raw.githubusercontent.com/owner/repo/main/path/file.ts");
  });

  it("strips multiple leading slashes from the file path", () => {
    const url = resolveRawGitHubUrl("github.com", "owner", "repo", "main", "///deep/file.ts");
    expect(url).toBe("https://raw.githubusercontent.com/owner/repo/main/deep/file.ts");
  });

  it("returns a GitHub Enterprise raw URL for custom hostnames", () => {
    const url = resolveRawGitHubUrl(
      "github.mycompany.com",
      "owner",
      "repo",
      "feature/branch",
      "src/index.ts",
    );
    expect(url).toBe(
      "https://github.mycompany.com/raw/owner/repo/feature/branch/src/index.ts",
    );
  });

  it("handles refs with slashes correctly", () => {
    const url = resolveRawGitHubUrl("github.com", "org", "proj", "refs/heads/main", "README.md");
    expect(url).toBe("https://raw.githubusercontent.com/org/proj/refs/heads/main/README.md");
  });
});

describe("ghFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the Response on success", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await ghFetch("https://api.github.com/repos/owner/repo");
    expect(result).toBe(mockResponse);
  });

  it("forwards init options to fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);

    const init = { headers: { Authorization: "Bearer token" } };
    await ghFetch("https://api.github.com/foo", init);

    expect(mockFetch).toHaveBeenCalledWith("https://api.github.com/foo", init);
  });

  it("throws an HttpError wrapping network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(
      ghFetch("https://github.mycompany.com/api/v3/repos/owner/repo"),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("github.mycompany.com"),
    });
  });
});
