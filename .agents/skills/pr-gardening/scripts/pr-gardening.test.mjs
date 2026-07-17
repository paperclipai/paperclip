import assert from "node:assert/strict";
import test from "node:test";
import { confidenceFor, readinessVerdict } from "./check-readiness.mjs";
import { findCandidates } from "./find-candidates.mjs";
import { chooseOriginatingIssue, extractPullRequestNumber, isMissingPullRequestError, normalizeCheck } from "./lib.mjs";
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

test("candidate discovery deduplicates mentions and drops closed PRs", async () => {
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
            ],
          },
        ],
      };
    }
    return [{ type: "pull_request", url: "https://github.com/paperclipai/paperclip/pull/1/" }];
  };
  const ghJson = (args) => {
    const number = Number(args[2]);
    if (number === 3) throw new Error("GraphQL: Could not resolve to a PullRequest with the number of 3");
    return {
      number,
      url: `https://github.com/paperclipai/paperclip/pull/${number}`,
      title: `PR ${number}`,
      state: number === 1 ? "OPEN" : "MERGED",
      isDraft: false,
      headRefOid: `sha-${number}`,
      updatedAt: "2026-07-13T00:00:00Z",
    };
  };
  const result = await findCandidates({
    repo: "paperclipai/paperclip",
    api_url: "http://paperclip.test",
    api_key: "test-key",
    company_id: "company-1",
    paperclip_get: paperclipGet,
    gh_json: ghJson,
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.number), [1]);
  assert.equal(new URL(`http://paperclip.test${extractPath}`).searchParams.get("matchesPerIssue"), "200");
  assert.equal(result.candidates[0].sourceIssues[0].mentions.length, 2);
  assert.equal(result.candidates[0].originatingIssue.selectionBasis, "pull_request_work_product");
  assert.deepEqual(result.source.droppedClosedPullRequests.map((pullRequest) => pullRequest.number), [2]);
  assert.deepEqual(result.source.droppedUnavailablePullRequests.map((pullRequest) => pullRequest.number), [3]);
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

test("renders confidence groups and immutable guardrail", () => {
  const entry = {
    number: 1,
    url: "https://github.com/paperclipai/paperclip/pull/1",
    title: "Example",
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
    generatedAt: "2026-07-13T00:00:00Z",
    summary: { ready: 1, needsGardening: 0, reportOnly: 0 },
    pullRequests: [entry],
  });
  assert.match(report, /## High Confidence/);
  assert.match(report, /never merges, approves, or closes/);
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
