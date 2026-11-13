import { describe, expect, it } from "vitest";
import { blockedInboxReviewWaitIssueIds } from "../services/issues.js";
import {
  classifyIssueGraphLiveness,
  type IssueGraphLivenessInput,
  type IssueLivenessIssueInput,
} from "../services/recovery/issue-graph-liveness.js";

const companyId = "company-1";
const agentId = "agent-1";

function issue(id: string, status: string): IssueLivenessIssueInput {
  return { id, companyId, identifier: id.toUpperCase(), title: id, status, assigneeAgentId: agentId };
}

// Rows are the page. Off-page review tasks also wait for an external reply.
const issues = [
  issue("row-blocked", "blocked"),
  issue("review-blocker", "in_review"),
  issue("row-review", "in_review"),
  issue("row-chain", "blocked"),
  issue("middle", "blocked"),
  issue("deep-review", "in_review"),
  issue("row-cycle", "blocked"),
  issue("cycle-peer", "blocked"),
  issue("row-todo", "todo"),
  issue("off-page-review", "in_review"),
  issue("off-page-blocked", "blocked"),
  issue("off-page-blocker", "in_review"),
];
const relation = (blockerIssueId: string, blockedIssueId: string) => ({ companyId, blockerIssueId, blockedIssueId });
const relations = [
  relation("review-blocker", "row-blocked"),
  relation("middle", "row-chain"),
  relation("deep-review", "middle"),
  relation("cycle-peer", "row-cycle"),
  relation("row-cycle", "cycle-peer"),
  relation("off-page-blocker", "off-page-blocked"),
  // A blocker shared with an off-page task stays in the rows' closure.
  relation("review-blocker", "off-page-blocked"),
];
const rowIds = ["row-blocked", "row-review", "row-chain", "row-cycle", "row-todo"];
const allWaits = issues.filter((entry) => entry.status === "in_review")
  .map((entry) => ({ id: `wait-${entry.id}`, companyId, issueId: entry.id, status: "waiting" }));

function rowFindings(externalResponseWaits: IssueGraphLivenessInput["externalResponseWaits"]) {
  const findings = classifyIssueGraphLiveness({
    issues,
    relations,
    agents: [{ id: agentId, companyId, name: "Coder", role: "engineer", status: "active", reportsTo: null }],
    externalResponseWaits,
    now: new Date("2026-11-10T00:00:00Z"),
  });
  return findings.filter((finding) => rowIds.includes(finding.issueId))
    .map(({ issueId, state, recoveryIssueId }) => ({ issueId, state, recoveryIssueId }))
    .sort((left, right) => left.issueId.localeCompare(right.issueId));
}

describe("blocked inbox review wait scope", () => {
  it("reads waits only for in-review rows and in-review blockers that the rows reach", () => {
    expect(blockedInboxReviewWaitIssueIds(rowIds, issues, relations).sort())
      .toEqual(["deep-review", "review-blocker", "row-review"]);
  });

  it("gives the rows the same findings as waits for every in-review task", () => {
    const narrowedIds = new Set(blockedInboxReviewWaitIssueIds(rowIds, issues, relations));
    const narrowed = allWaits.filter((wait) => narrowedIds.has(wait.issueId));
    expect(narrowed.length).toBeLessThan(allWaits.length);
    expect(rowFindings(narrowed)).toEqual(rowFindings(allWaits));
    // The waits matter: without them, the review rows and blockers have no action path.
    expect(rowFindings([])).not.toEqual(rowFindings(allWaits));
    for (const wait of narrowed) {
      expect(rowFindings(narrowed.filter((other) => other !== wait))).not.toEqual(rowFindings(allWaits));
    }
  });

  it("returns nothing for rows without in-review tasks in their blocker closure", () => {
    expect(blockedInboxReviewWaitIssueIds(["row-todo", "missing"], issues, relations)).toEqual([]);
    expect(blockedInboxReviewWaitIssueIds([], issues, relations)).toEqual([]);
  });
});
