import { describe, expect, it } from "vitest";
import type { IssuePrLink } from "@paperclipai/shared";
import {
  isRefreshableGitHubPrHostname,
  mapPullRequestState,
  mergePrLinkStatus,
  parseGitHubPrUrl,
} from "./pr-links.js";

describe("parseGitHubPrUrl", () => {
  it("parses a github.com pull request URL", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/repo/pull/42")).toEqual({
      hostname: "github.com",
      owner: "acme",
      repo: "repo",
      number: 42,
    });
  });

  it("parses a GitHub Enterprise host", () => {
    expect(parseGitHubPrUrl("https://git.corp.example.com/team/service/pull/7")).toEqual({
      hostname: "git.corp.example.com",
      owner: "team",
      repo: "service",
      number: 7,
    });
  });

  it("tolerates trailing path/query/hash segments", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/repo/pull/42/files?w=1#diff")?.number).toBe(42);
  });

  it("returns null for non-PR GitHub URLs", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/repo/issues/42")).toBeNull();
    expect(parseGitHubPrUrl("https://github.com/acme/repo")).toBeNull();
  });

  it("returns null for invalid or non-http URLs", () => {
    expect(parseGitHubPrUrl("not-a-url")).toBeNull();
    expect(parseGitHubPrUrl("ftp://github.com/acme/repo/pull/1")).toBeNull();
    expect(parseGitHubPrUrl("https://github.com/acme/repo/pull/0")).toBeNull();
  });
});

describe("isRefreshableGitHubPrHostname", () => {
  it("allows github.com hosts for status refresh", () => {
    expect(isRefreshableGitHubPrHostname("github.com")).toBe(true);
    expect(isRefreshableGitHubPrHostname("www.github.com")).toBe(true);
  });

  it("rejects arbitrary enterprise or internal hosts for status refresh", () => {
    expect(isRefreshableGitHubPrHostname("git.corp.example.com")).toBe(false);
    expect(isRefreshableGitHubPrHostname("169.254.169.254")).toBe(false);
  });
});

describe("mapPullRequestState", () => {
  it("maps merged before any other state", () => {
    expect(mapPullRequestState({ state: "closed", merged: true })).toBe("merged");
    expect(mapPullRequestState({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })).toBe("merged");
  });

  it("maps closed PRs", () => {
    expect(mapPullRequestState({ state: "closed", merged: false })).toBe("closed");
  });

  it("maps draft open PRs", () => {
    expect(mapPullRequestState({ state: "open", draft: true })).toBe("draft");
  });

  it("defaults to open", () => {
    expect(mapPullRequestState({ state: "open" })).toBe("open");
    expect(mapPullRequestState({})).toBe("open");
  });
});

describe("mergePrLinkStatus", () => {
  const existing: IssuePrLink[] = [
    {
      url: "https://github.com/acme/repo/pull/1",
      title: "old title",
      state: "open",
      statusFetchedAt: "2026-01-01T00:00:00Z",
    },
  ];

  it("preserves cached status for a URL that survives a title-only edit", () => {
    const merged = mergePrLinkStatus(existing, [
      { url: "https://github.com/acme/repo/pull/1", title: "new title" },
    ]);
    expect(merged[0]).toMatchObject({
      url: "https://github.com/acme/repo/pull/1",
      title: "new title",
      state: "open",
      statusFetchedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("starts brand-new entries with no cached status", () => {
    const merged = mergePrLinkStatus(existing, [
      { url: "https://github.com/acme/repo/pull/2" },
    ]);
    expect(merged[0]?.state).toBeUndefined();
    expect(merged[0]?.title).toBeNull();
  });

  it("drops cached status when a URL is removed", () => {
    const merged = mergePrLinkStatus(existing, []);
    expect(merged).toHaveLength(0);
  });
});
