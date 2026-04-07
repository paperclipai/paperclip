import { afterEach, describe, expect, it, vi } from "vitest";
import { detectGitType, resolveRawGitHubUrl } from "../services/github-fetch.js";

// detectGitType caches results in module-level state — reset between tests by
// reimporting the module fresh.  We clear the cache via the fetch mock instead.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  mockFetch.mockReset();
  // Reset the module's internal cache by clearing all cached entries.
  // We do this by re-running detectGitType with fresh mocks in each test.
});

describe("resolveRawGitHubUrl", () => {
  it("returns raw.githubusercontent.com URL for github.com", () => {
    const url = resolveRawGitHubUrl("github.com", "acme", "skills", "main", "SKILL.md", "github");
    expect(url).toBe("https://raw.githubusercontent.com/acme/skills/main/SKILL.md");
  });

  it("returns GHE-style URL for GitHub Enterprise hosts", () => {
    const url = resolveRawGitHubUrl("ghe.acme.com", "acme", "skills", "main", "docs/SKILL.md", "ghe");
    expect(url).toBe("https://ghe.acme.com/raw/acme/skills/main/docs/SKILL.md");
  });

  it("returns Gitea-style URL for Gitea hosts", () => {
    const url = resolveRawGitHubUrl("git.acme.com", "acme", "skills", "main", "SKILL.md", "gitea");
    expect(url).toBe("https://git.acme.com/acme/skills/raw/branch/main/SKILL.md");
  });

  it("returns Gitea-style URL for nested paths on Gitea", () => {
    const url = resolveRawGitHubUrl("git.acme.com", "acme", "skills", "main", "scripts/run.sh", "gitea");
    expect(url).toBe("https://git.acme.com/acme/skills/raw/branch/main/scripts/run.sh");
  });

  it("strips leading slash from filePath", () => {
    const url = resolveRawGitHubUrl("git.acme.com", "acme", "skills", "main", "/SKILL.md", "gitea");
    expect(url).toBe("https://git.acme.com/acme/skills/raw/branch/main/SKILL.md");
  });

  it("defaults to GHE format when gitType is omitted", () => {
    const url = resolveRawGitHubUrl("ghe.acme.com", "acme", "skills", "main", "SKILL.md");
    expect(url).toBe("https://ghe.acme.com/raw/acme/skills/main/SKILL.md");
  });
});

describe("detectGitType", () => {
  it("returns 'github' for github.com without probing", async () => {
    const type = await detectGitType("github.com");
    expect(type).toBe("github");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 'gitea' when /api/v1/version responds with 200", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const type = await detectGitType("git.mycompany.com-probe-gitea");
    expect(type).toBe("gitea");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://git.mycompany.com-probe-gitea/api/v1/version",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("returns 'ghe' when /api/v1/version responds with non-200", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const type = await detectGitType("ghe.mycompany.com-probe-ghe");
    expect(type).toBe("ghe");
  });

  it("returns 'ghe' when the probe throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const type = await detectGitType("offline.mycompany.com-probe-error");
    expect(type).toBe("ghe");
  });
});
