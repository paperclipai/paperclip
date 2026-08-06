import assert from "node:assert/strict";
import test from "node:test";
import { confidenceFor, readinessVerdict } from "./check-readiness.mjs";
import { findCandidates } from "./find-candidates.mjs";
import {
  chooseOriginatingIssue,
  extractPullRequestNumber,
  isMissingPullRequestError,
  normalizeCheck,
  resolveAuthorAllowlist,
  summarizePullRequestBody,
} from "./lib.mjs";
import { renderReport } from "./render-report.mjs";

test("extracts only pull requests from the requested repository", () => {
  assert.equal(extractPullRequestNumber("https://github.com/paperclipai/paperclip/pull/9507", "paperclipai/paperclip"), 9507);
  assert.equal(extractPullRequestNumber("github.com/paperclipai/paperclip/pull/9507", "paperclipai/paperclip"), 9507);
  assert.equal(extractPullRequestNumber("https://github.com/other/repo/pull/9507", "paperclipai/paperclip"), null);
});

test("origin selection prioritizes work products then comment mentions", () => {
  const issues = [
    {
      issueId: "recent",
      identifier: "PAP-2",
      title: "Recent",
      status: "in_progress",
      assigneeAgentId: "agent-2",
      updatedAt: "2026-07-13T12:00:00Z",
      mentions: [{ field: "description" }],
      workProducts: [],
    },
    {
      issueId: "origin",
      identifier: "PAP-1",
      title: "Origin",
      status: "done",
      assigneeAgentId: "agent-1",
      updatedAt: "2026-07-12T12:00:00Z",
      mentions: [{ field: "comment" }],
      workProducts: [{ type: "pull_request", url: "http://github.com/paperclipai/paperclip/pull/9507?source=paperclip#review" }],
    },
  ];
  assert.equal(chooseOriginatingIssue(issues, "https://github.com/paperclipai/paperclip/pull/9507").issueId, "origin");
});

function discoveryFixture() {
  let extractPath = "";
  const paperclipGet = async (path) => {
    if (path.includes("search/extract")) {
      extractPath = path;
      return {
        hasMore: false,
        results: [
          {
            issueId: "issue-1",
            identifier: "PAP-1",
            title: "Source",
            status: "done",
            assigneeAgentId: "agent-1",
            updatedAt: "2026-07-13T00:00:00Z",
            matchesTruncated: false,
            matches: [
              { value: "https://github.com/paperclipai/paperclip/pull/1", field: "comment", label: "Comment", source: { type: "comment", commentId: "c1" } },
              { value: "https://github.com/paperclipai/paperclip/pull/1", field: "document_body", label: "Document", source: { type: "document", documentId: "d1", documentKey: "plan" } },
              { value: "https://github.com/paperclipai/paperclip/pull/2", field: "description", label: "Description", source: { type: "issue", issueId: "issue-1" } },
              { value: "https://github.com/paperclipai/paperclip/pull/3", field: "description", label: "Description", source: { type: "issue", issueId: "issue-1" } },
              { value: "https://github.com/paperclipai/paperclip/pull/4", field: "comment", label: "Comment", source: { type: "comment", commentId: "c2" } },
            ],
          },
        ],
      };
    }
    return [{ type: "pull_request", url: "https://github.com/paperclipai/paperclip/pull/1/" }];
  };
  const ghJson = (args) => {
    if (args[0] === "api" && args[1] === "user") return { login: "Cryppadotta" };
    const number = Number(args[2]);
    if (number === 3) throw new Error("GraphQL: Could not resolve to a PullRequest with the number of 3");
    return {
      number,
      url: `https://github.com/paperclipai/paperclip/pull/${number}`,
      title: `PR ${number}`,
      author: { login: number === 4 ? "community-dev" : "cryppadotta" },
      state: number === 1 || number === 4 ? "OPEN" : "MERGED",
      isDraft: false,
      headRefOid: `sha-${number}`,
      updatedAt: "2026-07-13T00:00:00Z",
    };
  };
  return { paperclipGet, ghJson, extractPath: () => extractPath };
}

test("candidate discovery deduplicates mentions, drops closed PRs, and excludes community authors by default", async () => {
  const fixture = discoveryFixture();
  const result = await findCandidates({
    repo: "paperclipai/paperclip",
    api_url: "http://paperclip.test",
    api_key: "test-key",
    company_id: "company-1",
    now: "2026-07-20T00:00:00Z",
    paperclip_get: fixture.paperclipGet,
    gh_json: fixture.ghJson,
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.number), [1]);
  assert.equal(result.candidates[0].author, "cryppadotta");
  const query = new URL(`http://paperclip.test${fixture.extractPath()}`).searchParams;
  assert.equal(query.get("matchesPerIssue"), "200");
  assert.equal(query.get("updatedWithin"), "14d");
  assert.deepEqual(result.query.authors, ["cryppadotta"]);
  assert.equal(result.candidates[0].sourceIssues[0].mentions.length, 2);
  assert.equal(result.candidates[0].originatingIssue.selectionBasis, "pull_request_work_product");
  assert.deepEqual(result.source.droppedClosedPullRequests.map((pullRequest) => pullRequest.number), [2]);
  assert.deepEqual(result.source.droppedUnavailablePullRequests.map((pullRequest) => pullRequest.number), [3]);
  assert.deepEqual(
    result.source.droppedCommunityPullRequests.map((pullRequest) => [pullRequest.number, pullRequest.author]),
    [[4, "community-dev"]],
  );
});

test("capped match sets are recorded instead of aborting discovery", async () => {
  const fixture = discoveryFixture();
  const paperclipGet = async (path) => {
    const page = await fixture.paperclipGet(path);
    if (!path.includes("search/extract")) return page;
    return { ...page, results: page.results.map((issue) => ({ ...issue, matchesTruncated: true })) };
  };
  const result = await findCandidates({
    repo: "paperclipai/paperclip",
    api_url: "http://paperclip.test",
    api_key: "test-key",
    company_id: "company-1",
    now: "2026-07-20T00:00:00Z",
    paperclip_get: paperclipGet,
    gh_json: fixture.ghJson,
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.number), [1]);
  assert.equal(result.source.truncated, true);
  assert.deepEqual(result.source.truncatedIssues.map((issue) => issue.identifier), ["PAP-1"]);
});

test("--include-community disables the author filter", async () => {
  const fixture = discoveryFixture();
  const result = await findCandidates({
    repo: "paperclipai/paperclip",
    api_url: "http://paperclip.test",
    api_key: "test-key",
    company_id: "company-1",
    include_community: true,
    now: "2026-07-20T00:00:00Z",
    paperclip_get: fixture.paperclipGet,
    gh_json: fixture.ghJson,
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.number), [1, 4]);
  assert.equal(result.query.authors, null);
  assert.deepEqual(result.source.droppedCommunityPullRequests, []);
});

test("open PRs with no activity inside the window are dropped as stale", async () => {
  const fixture = discoveryFixture();
  const result = await findCandidates({
    repo: "paperclipai/paperclip",
    api_url: "http://paperclip.test",
    api_key: "test-key",
    company_id: "company-1",
    now: "2026-09-01T00:00:00Z",
    paperclip_get: fixture.paperclipGet,
    gh_json: fixture.ghJson,
  });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(
    result.source.droppedStalePullRequests.map((pullRequest) => pullRequest.number),
    [1],
  );
});

test("author allowlist resolves from gh identity and honors --authors overrides", () => {
  const ghJson = () => ({ login: "Cryppadotta" });
  assert.deepEqual(resolveAuthorAllowlist({}, ghJson), ["cryppadotta"]);
  assert.deepEqual(resolveAuthorAllowlist({ authors: "Alice, bob" }, ghJson), ["alice", "bob"]);
  assert.equal(resolveAuthorAllowlist({ include_community: true }, ghJson), null);
  assert.throws(() => resolveAuthorAllowlist({ authors: true }, ghJson), /comma-separated list/);
});

test("summarizes PR bodies into a one-line purpose", () => {
  assert.equal(
    summarizePullRequestBody("<!-- generated -->\n## Summary\n\nFixes the flaky retry loop\nso wakes stop duplicating.\n\nDetails follow."),
    "Fixes the flaky retry loop so wakes stop duplicating.",
  );
  assert.equal(
    summarizePullRequestBody("> - Paperclip is the control plane.\n> - Blocker edges gate work."),
    "Paperclip is the control plane. Blocker edges gate work.",
  );
  assert.equal(summarizePullRequestBody(""), null);
  assert.equal(summarizePullRequestBody(null), null);
  assert.equal(summarizePullRequestBody(`${"x".repeat(400)}`).length, 278);
});

test("missing-PR detection matches only deleted/nonexistent PR signals", () => {
  // gh's real signals for a deleted/nonexistent PR: GraphQL resolution failure and REST 404.
  assert.equal(isMissingPullRequestError(new Error("GraphQL: Could not resolve to a PullRequest with the number of 3")), true);
  assert.equal(isMissingPullRequestError({ stderr: "gh: Not Found (HTTP 404)" }), true);
  // Unrelated failures that merely contain "not found" must not be treated as skippable.
  assert.equal(isMissingPullRequestError(new Error("repository not found")), false);
  assert.equal(isMissingPullRequestError(new Error("could not connect to github.com")), false);
  assert.equal(isMissingPullRequestError(undefined), false);
});

test("normalizes check runs and status contexts", () => {
  assert.equal(normalizeCheck({ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }).green, true);
  assert.equal(normalizeCheck({ __typename: "StatusContext", context: "legacy", state: "FAILURE" }).green, false);
});

test("drafts are report-only and missing Greptile blocks normal PRs", () => {
  const base = {
    pullRequest: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED" },
    checks: { checks: [{}], pending: [], failing: [] },
    greptile: { present: false, pending: false, clean: false },
    behindBy: 0,
    originatingIssue: { status: "done", identifier: "PAP-1" },
  };
  assert.equal(readinessVerdict(base).verdict, "needs_gardening");
  assert.equal(readinessVerdict({ ...base, pullRequest: { ...base.pullRequest, isDraft: true } }).verdict, "report_only");
});

test("unresolved nullable mergeability is reported instead of crashing", () => {
  const result = readinessVerdict({
    pullRequest: { state: "OPEN", isDraft: false, mergeable: null, mergeStateStatus: null, reviewDecision: "" },
    checks: { checks: [{}], pending: [], failing: [] },
    greptile: { present: true, pending: false, clean: true },
    behindBy: 0,
    originatingIssue: { status: "done", identifier: "PAP-1" },
  });
  assert.equal(result.verdict, "needs_gardening");
  assert.equal(result.reasons[0].code, "mergeability_unknown");
});

test("renders scope, purpose, confidence groups, and immutable guardrail", () => {
  const entry = {
    number: 1,
    url: "https://github.com/paperclipai/paperclip/pull/1",
    title: "Example",
    author: "cryppadotta",
    purpose: "Fixes the retry loop.",
    state: "open",
    isDraft: false,
    verdict: "ready",
    confidence: "high",
    headSha: "abc",
    originatingIssue: { identifier: "PAP-1", status: "done" },
    checks: { checks: [{}], pending: [], failing: [] },
    greptile: { clean: true, present: true },
    behindBy: 0,
    baseRefName: "master",
    reasons: [],
  };
  assert.equal(confidenceFor(entry), "high");
  const report = renderReport({
    repository: "paperclipai/paperclip",
    windowDays: 14,
    authors: ["cryppadotta"],
    generatedAt: "2026-07-13T00:00:00Z",
    summary: { ready: 1, needsGardening: 0, reportOnly: 0 },
    pullRequests: [entry],
  });
  assert.match(report, /Scope: PRs authored by `cryppadotta` \(this Paperclip instance\) referenced by issues active in the last 14 day\(s\)/);
  assert.match(report, /- Purpose: Fixes the retry loop\./);
  assert.match(report, /- Author: `cryppadotta`/);
  assert.match(report, /## High Confidence/);
  assert.match(report, /never merges, approves, or closes/);
});

test("escapes contributor-controlled Markdown in report titles and purposes", () => {
  const report = renderReport({
    repository: "paperclipai/paperclip",
    windowDays: 14,
    authors: null,
    generatedAt: "2026-07-27T00:00:00Z",
    summary: { ready: 0, needsGardening: 1, reportOnly: 0 },
    pullRequests: [
      {
        number: 2,
        url: "https://github.com/paperclipai/paperclip/pull/2",
        title: "[Injected](https://example.test)",
        author: "community-user",
        purpose: "![tracking pixel](https://example.test/pixel.png) <img src=x>",
        state: "open",
        isDraft: false,
        verdict: "needs_gardening",
        confidence: "medium",
        headSha: "def",
        originatingIssue: null,
        checks: { checks: [{}], pending: [], failing: [] },
        greptile: { clean: false, present: false },
        behindBy: 0,
        baseRefName: "master",
        reasons: [],
      },
    ],
  });
  assert.ok(report.includes("\\[Injected\\]\\(https://example.test\\)"));
  assert.ok(report.includes("\\!\\[tracking pixel\\]\\(https://example.test/pixel.png\\)"));
  assert.ok(report.includes("\\<img src=x\\>"));
  assert.doesNotMatch(report, /!\[tracking pixel\]|<img src=x>/);
});

test("scripts contain no mutating GitHub commands", async () => {
  const { readFile } = await import("node:fs/promises");
  const scripts = await Promise.all([
    readFile(new URL("./find-candidates.mjs", import.meta.url), "utf8"),
    readFile(new URL("./check-readiness.mjs", import.meta.url), "utf8"),
    readFile(new URL("./render-report.mjs", import.meta.url), "utf8"),
  ]);
  const source = scripts.join("\n");
  assert.doesNotMatch(source, /\bgh\s+pr\s+(merge|close|review|comment|ready|reopen)\b/i);
  assert.doesNotMatch(source, /--method\s+(POST|PATCH|PUT|DELETE)\b/i);
});
