import { describe, it, expect } from "vitest";
import { gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";

// ---------------------------------------------------------------------------
// gitHubApiBase
// ---------------------------------------------------------------------------

describe("gitHubApiBase", () => {
  it("returns the public GitHub API URL for 'github.com'", () => {
    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
  });

  it("returns the public GitHub API URL for 'www.github.com'", () => {
    expect(gitHubApiBase("www.github.com")).toBe("https://api.github.com");
  });

  it("is case-insensitive for 'GITHUB.COM'", () => {
    expect(gitHubApiBase("GITHUB.COM")).toBe("https://api.github.com");
  });

  it("returns a GHE API URL for a custom hostname", () => {
    expect(gitHubApiBase("github.example.com")).toBe("https://github.example.com/api/v3");
  });

  it("returns a GHE API URL for another custom hostname", () => {
    expect(gitHubApiBase("git.corp.internal")).toBe("https://git.corp.internal/api/v3");
  });
});

// ---------------------------------------------------------------------------
// resolveRawGitHubUrl
// ---------------------------------------------------------------------------

describe("resolveRawGitHubUrl", () => {
  it("returns a raw.githubusercontent.com URL for github.com", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "repo", "main", "README.md");
    expect(url).toBe("https://raw.githubusercontent.com/acme/repo/main/README.md");
  });

  it("returns a GHE raw URL for a custom hostname", () => {
    const url = resolveRawGitHubUrl("github.example.com", "acme", "repo", "main", "README.md");
    expect(url).toBe("https://github.example.com/raw/acme/repo/main/README.md");
  });

  it("strips a leading slash from the file path", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "repo", "main", "/path/file.ts");
    expect(url).toBe("https://raw.githubusercontent.com/acme/repo/main/path/file.ts");
  });

  it("strips multiple leading slashes from the file path", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "repo", "main", "//nested/file.ts");
    expect(url).toBe("https://raw.githubusercontent.com/acme/repo/main/nested/file.ts");
  });

  it("handles a ref with slashes (branch name)", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "repo", "feature/x", "src/index.ts");
    expect(url).toBe("https://raw.githubusercontent.com/acme/repo/feature/x/src/index.ts");
  });

  it("handles a nested file path", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "repo", "v1.0.0", "packages/lib/index.ts");
    expect(url).toBe("https://raw.githubusercontent.com/acme/repo/v1.0.0/packages/lib/index.ts");
  });

  it("handles a GHE hostname with a nested file path", () => {
    const url = resolveRawGitHubUrl("git.corp.internal", "team", "monorepo", "dev", "apps/api/main.ts");
    expect(url).toBe("https://git.corp.internal/raw/team/monorepo/dev/apps/api/main.ts");
  });
});
