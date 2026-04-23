import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  formatAutoMergeReportMarkdown,
  parseGitHubPrUrl,
  runGithubPullRequestAutoMergeForDoneIssue,
  shouldSkipAutoMergeForProjectPolicy,
} from "../issue-github-pr-auto-merge.js";

describe("issue-github-pr-auto-merge", () => {
  it("parses github.com pull URLs", () => {
    expect(parseGitHubPrUrl("https://github.com/o/r/pull/12")).toEqual({
      owner: "o",
      repo: "r",
      number: 12,
      hostname: "github.com",
    });
    expect(parseGitHubPrUrl("https://github.com/o/r/pull/12/files")).toEqual({
      owner: "o",
      repo: "r",
      number: 12,
      hostname: "github.com",
    });
    expect(parseGitHubPrUrl("not a url")).toBeNull();
  });

  it("honors project opt-out", () => {
    const { skip } = shouldSkipAutoMergeForProjectPolicy({
      executionWorkspacePolicy: { pullRequestPolicy: { disableAutoMergeOnIssueDone: true } },
    });
    expect(skip).toBe(true);
    const { skip: skip2 } = shouldSkipAutoMergeForProjectPolicy({
      executionWorkspacePolicy: { pullRequestPolicy: {} },
    });
    expect(skip2).toBe(false);
  });

  it("formats a report", () => {
    const md = formatAutoMergeReportMarkdown(
      [
        {
          pr: { owner: "a", repo: "b", number: 1, hostname: "github.com" },
          result: "merged",
          htmlUrl: "https://github.com/a/b/pull/1",
        },
        {
          pr: { owner: "a", repo: "b", number: 2, hostname: "github.com" },
          result: "failed",
          reason: "blocked",
          detail: "checks",
          htmlUrl: "https://github.com/a/b/pull/2",
        },
      ],
      "X-1",
    );
    expect(md).toContain("X-1");
    expect(md).toContain("Merged:");
    expect(md).toContain("Failed:");
  });
});

describe("runGithubPullRequestAutoMergeForDoneIssue (mocked fetch)", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/pulls/3") && (init?.method ?? "GET") === "GET") {
          return {
            ok: true,
            json: async () => ({
              html_url: "https://github.com/o/r/pull/3",
              merged: false,
              state: "open",
              mergeable: true,
              mergeable_state: "clean",
            }),
          };
        }
        if (u.includes("/pulls/3/merge") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ merged: true, sha: "abc" }) };
        }
        return { ok: false, status: 404, json: async () => ({ message: "nope" }) };
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("merges when GitHub reports clean", async () => {
    const results = await runGithubPullRequestAutoMergeForDoneIssue({
      issue: {
        id: "i1",
        projectId: null,
        title: "t",
        description: "https://github.com/o/r/pull/3",
        identifier: "T-1",
      },
      workProducts: [],
      mergeToken: "tok",
      mergeMethod: "squash",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toBe("merged");
  });
});
