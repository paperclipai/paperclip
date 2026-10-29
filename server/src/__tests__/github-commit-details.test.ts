import { describe, expect, it, vi } from "vitest";
import {
  createGitHubCommitDiffDetailsResolver,
  extractGitHubCommitReference,
} from "../services/github-commit-details.js";

describe("GitHub commit details", () => {
  it("extracts commit references from URLs and metadata shorthand", () => {
    expect(extractGitHubCommitReference([
      "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
    ])).toEqual({
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      sha: "9c12ae7b41e5",
    });
    expect(extractGitHubCommitReference(["paperclipai/paperclip@9c12ae7b41e5"])?.sha)
      .toBe("9c12ae7b41e5");
  });

  it("resolves stats and counts files across GitHub response pages", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stats: { additions: 18, deletions: 5 },
        files: [{ filename: "a.ts" }, { filename: "b.ts" }],
      }), {
        status: 200,
        headers: { link: '<https://api.github.com/repos/acme/app/commits/abc1234?per_page=100&page=2>; rel="next"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stats: { additions: 18, deletions: 5 },
        files: [{ filename: "c.ts" }],
      }), { status: 200 }));
    const resolve = createGitHubCommitDiffDetailsResolver({} as any, {
      fetch,
      tokenProvider: async () => "secret-token",
    });

    await expect(resolve("company-1", {
      host: "github.com",
      owner: "acme",
      repo: "app",
      sha: "abc1234",
    })).resolves.toEqual({ additions: 18, deletions: 5, changedFiles: 3 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/acme/app/commits/abc1234?per_page=100&page=1",
      "https://api.github.com/repos/acme/app/commits/abc1234?per_page=100&page=2",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret-token" }),
    }));
  });

  it("returns null for unavailable or malformed commit details", async () => {
    const resolve = createGitHubCommitDiffDetailsResolver({} as any, {
      fetch: async () => new Response(JSON.stringify({ files: [] }), { status: 200 }),
      tokenProvider: null,
    });
    await expect(resolve("company-1", {
      host: "github.com",
      owner: "acme",
      repo: "app",
      sha: "abc1234",
    })).resolves.toBeNull();
  });
});
