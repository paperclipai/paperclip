import { describe, expect, it } from "vitest";
import { extractGitHubPullRequestReferences } from "./github-pull-request-references.js";

describe("GitHub pull request reference extraction", () => {
  it("accepts common Markdown and JSON URL endings without accepting suffix text", () => {
    expect(extractGitHubPullRequestReferences([
      "`https://github.com/acme/project/pull/42`",
      "<https://github.com/acme/project/pull/43>",
      '"https://github.com/acme/project/pull/44"',
      "https://github.com/acme/project/pull/45garbage",
    ], { includeShorthand: false })).toEqual([
      { host: "github.com", owner: "acme", repo: "project", number: 42 },
      { host: "github.com", owner: "acme", repo: "project", number: 43 },
      { host: "github.com", owner: "acme", repo: "project", number: 44 },
    ]);
  });
});
