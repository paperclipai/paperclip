import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { LiveRunCoverageByCompany } from "./liveIssueIds";
import {
  collectLiveIssueIds,
  collectSubtreeLiveCounts,
  INITIAL_LIVE_RUN_COVERAGE,
  isCompanyLiveRunCoverageComplete,
  isLiveRunCoverageComplete,
  LIVE_RUNS_PAGE_LIMIT,
  trackLiveRunCoverage,
} from "./liveIssueIds";

function liveRun(overrides: Partial<LiveRunForIssue>): LiveRunForIssue {
  return {
    id: "run",
    status: "running",
    invocationSource: "scheduler",
    triggerDetail: null,
    startedAt: "2026-04-20T10:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    agentId: "agent",
    agentName: "Agent",
    adapterType: "codex_local",
    issueId: "issue",
    ...overrides,
  };
}

describe("isLiveRunCoverageComplete", () => {
  function runsOfLength(length: number): LiveRunForIssue[] {
    return Array.from({ length }, (_, index) => liveRun({ id: `run-${index}`, issueId: `issue-${index}` }));
  }

  it("treats a short page as the whole truth", () => {
    expect(isLiveRunCoverageComplete(runsOfLength(0))).toBe(true);
    expect(isLiveRunCoverageComplete(runsOfLength(LIVE_RUNS_PAGE_LIMIT - 1))).toBe(true);
  });

  it("treats a full page as possibly truncated", () => {
    // The route clamps `limit` to the page size, so a full page means there may
    // be live runs this client never saw — absence stops proving inactivity.
    expect(isLiveRunCoverageComplete(runsOfLength(LIVE_RUNS_PAGE_LIMIT))).toBe(false);
    expect(isLiveRunCoverageComplete(runsOfLength(LIVE_RUNS_PAGE_LIMIT + 10))).toBe(false);
  });

  it("counts an unloaded response as complete so nothing animates while loading", () => {
    expect(isLiveRunCoverageComplete(undefined)).toBe(true);
    expect(isLiveRunCoverageComplete(null)).toBe(true);
  });
});

describe("trackLiveRunCoverage", () => {
  function runsOfLength(length: number): LiveRunForIssue[] {
    return Array.from({ length }, (_, index) => liveRun({ id: `run-${index}`, issueId: `issue-${index}` }));
  }

  const COMPANY = "company-1";
  const OTHER = "company-2";

  function verdict(coverage: LiveRunCoverageByCompany, companyId: string | null): boolean {
    return isCompanyLiveRunCoverageComplete(coverage, companyId);
  }

  it("keeps a complete window complete", () => {
    const short = trackLiveRunCoverage(INITIAL_LIVE_RUN_COVERAGE, COMPANY, runsOfLength(3));
    expect(verdict(short, COMPANY)).toBe(true);
    expect(verdict(trackLiveRunCoverage(short, COMPANY, undefined), COMPANY)).toBe(true);
  });

  it("holds the truncated verdict after events shrink the cached page", () => {
    // A full page means runs we never saw. `removeRunFromList` then drops a
    // finished run from that same array without any refetch — the shorter list
    // says nothing about the runs the page hid, so the verdict must not flip.
    const truncated = trackLiveRunCoverage(INITIAL_LIVE_RUN_COVERAGE, COMPANY, runsOfLength(LIVE_RUNS_PAGE_LIMIT));
    expect(verdict(truncated, COMPANY)).toBe(false);
    expect(verdict(trackLiveRunCoverage(truncated, COMPANY, runsOfLength(LIVE_RUNS_PAGE_LIMIT - 1)), COMPANY)).toBe(false);
    expect(verdict(trackLiveRunCoverage(truncated, COMPANY, runsOfLength(0)), COMPANY)).toBe(false);
    expect(verdict(trackLiveRunCoverage(truncated, COMPANY, undefined), COMPANY)).toBe(false);
  });

  it("judges each company on its own page rather than the one before it", () => {
    // The provider outlives a company switch. A busy company must not leave the
    // next one animating every in-progress icon.
    const truncated = trackLiveRunCoverage(INITIAL_LIVE_RUN_COVERAGE, COMPANY, runsOfLength(LIVE_RUNS_PAGE_LIMIT));
    const switched = trackLiveRunCoverage(truncated, OTHER, runsOfLength(2));
    expect(verdict(switched, OTHER)).toBe(true);
    // A full page in the new company latches there, on its own evidence.
    expect(verdict(trackLiveRunCoverage(switched, OTHER, runsOfLength(LIVE_RUNS_PAGE_LIMIT)), OTHER)).toBe(false);
  });

  it("remembers a company's truncated verdict when you come back to it", () => {
    // React Query can still hold that company's array, and lifecycle events may
    // have shortened it below the cap while we were away. Re-reading the length
    // would call that shortened page complete without any fresh read.
    const truncated = trackLiveRunCoverage(INITIAL_LIVE_RUN_COVERAGE, COMPANY, runsOfLength(LIVE_RUNS_PAGE_LIMIT));
    const away = trackLiveRunCoverage(truncated, OTHER, runsOfLength(2));
    const back = trackLiveRunCoverage(away, COMPANY, runsOfLength(LIVE_RUNS_PAGE_LIMIT - 1));
    expect(verdict(back, COMPANY)).toBe(false);
    expect(verdict(back, OTHER)).toBe(true);
  });

  it("returns the same map when nothing changed, so the context value is stable", () => {
    const first = trackLiveRunCoverage(INITIAL_LIVE_RUN_COVERAGE, COMPANY, runsOfLength(3));
    expect(trackLiveRunCoverage(first, COMPANY, runsOfLength(4))).toBe(first);
  });
});

describe("collectLiveIssueIds", () => {
  it("keeps only runs linked to issues", () => {
    const liveRuns: LiveRunForIssue[] = [
      {
        id: "run-1",
        status: "running",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: "2026-04-20T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-20T10:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
      {
        id: "run-2",
        status: "queued",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-04-20T10:01:00.000Z",
        agentId: "agent-2",
        agentName: "Reviewer",
        adapterType: "codex_local",
        issueId: null,
      },
      {
        id: "run-3",
        status: "running",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: "2026-04-20T10:02:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-20T10:02:00.000Z",
        agentId: "agent-3",
        agentName: "Builder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
      {
        id: "run-4",
        status: "running",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: "2026-04-20T10:03:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-20T10:03:00.000Z",
        agentId: "agent-4",
        agentName: "Fixer",
        adapterType: "codex_local",
        issueId: "issue-2",
      },
      {
        id: "run-5",
        status: "succeeded",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: "2026-04-20T10:04:00.000Z",
        finishedAt: "2026-04-20T10:05:00.000Z",
        createdAt: "2026-04-20T10:04:00.000Z",
        agentId: "agent-5",
        agentName: "Done",
        adapterType: "codex_local",
        issueId: "completed-issue",
      },
    ];

    expect([...collectLiveIssueIds(liveRuns)]).toEqual(["issue-1", "issue-2"]);
  });

  it("suppresses live ids for terminal issues while keeping non-terminal issues live", () => {
    const liveRuns: LiveRunForIssue[] = [
      {
        id: "run-terminal",
        status: "running",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: "2026-04-20T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-20T10:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-done",
      },
      {
        id: "run-live",
        status: "queued",
        invocationSource: "scheduler",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-04-20T10:01:00.000Z",
        agentId: "agent-2",
        agentName: "Builder",
        adapterType: "codex_local",
        issueId: "issue-open",
      },
    ];

    expect([...collectLiveIssueIds(liveRuns, [
      { id: "issue-done", status: "done" },
      { id: "issue-open", status: "in_progress" },
    ])]).toEqual(["issue-open"]);
  });

  it("keeps newer terminal snapshots authoritative when stale non-terminal snapshots appear later", () => {
    const liveRuns: LiveRunForIssue[] = [
      liveRun({ id: "run-done", issueId: "issue-done", status: "running" }),
      liveRun({ id: "run-cancelled", issueId: "issue-cancelled", status: "queued" }),
      liveRun({ id: "run-open", issueId: "issue-open", status: "running" }),
    ];

    expect([...collectLiveIssueIds(liveRuns, [
      { id: "issue-done", status: "done", updatedAt: "2026-04-20T10:02:00.000Z" },
      { id: "issue-cancelled", status: "cancelled", updatedAt: "2026-04-20T10:02:00.000Z" },
      { id: "issue-open", status: "in_progress", updatedAt: "2026-04-20T10:02:00.000Z" },
      { id: "issue-done", status: "in_progress", updatedAt: "2026-04-20T10:01:00.000Z" },
      { id: "issue-cancelled", status: "todo", updatedAt: "2026-04-20T10:01:00.000Z" },
    ])]).toEqual(["issue-open"]);
  });

  it("allows a newer non-terminal snapshot to reopen an issue with a stale terminal snapshot", () => {
    const liveRuns: LiveRunForIssue[] = [
      liveRun({ id: "run-reopened", issueId: "issue-reopened", status: "running" }),
      liveRun({ id: "run-terminal", issueId: "issue-terminal", status: "queued" }),
    ];

    expect([...collectLiveIssueIds(liveRuns, [
      { id: "issue-reopened", status: "done", updatedAt: "2026-04-20T10:01:00.000Z" },
      { id: "issue-terminal", status: "in_progress", updatedAt: "2026-04-20T10:01:00.000Z" },
      { id: "issue-reopened", status: "in_progress", updatedAt: "2026-04-20T10:02:00.000Z" },
      { id: "issue-terminal", status: "done", updatedAt: "2026-04-20T10:02:00.000Z" },
    ])]).toEqual(["issue-reopened"]);
  });
});

describe("collectSubtreeLiveCounts", () => {
  const tree = [
    { id: "root", parentId: null },
    { id: "child-a", parentId: "root" },
    { id: "child-b", parentId: "root" },
    { id: "grandchild", parentId: "child-a" },
  ];

  it("rolls a live descendant up to every ancestor without crediting itself", () => {
    const counts = collectSubtreeLiveCounts(tree, new Set(["grandchild"]));
    expect(counts.get("root")).toBe(1);
    expect(counts.get("child-a")).toBe(1);
    expect(counts.has("child-b")).toBe(false);
    // The live issue itself never appears in its own subtree count.
    expect(counts.has("grandchild")).toBe(false);
  });

  it("counts multiple live descendants under a shared ancestor", () => {
    const counts = collectSubtreeLiveCounts(tree, new Set(["child-b", "grandchild"]));
    expect(counts.get("root")).toBe(2);
    expect(counts.get("child-a")).toBe(1);
    expect(counts.has("child-b")).toBe(false);
  });

  it("ignores live issues that are not part of the loaded tree", () => {
    const counts = collectSubtreeLiveCounts(tree, new Set(["not-loaded"]));
    expect(counts.size).toBe(0);
  });

  it("returns an empty map when nothing is live", () => {
    expect(collectSubtreeLiveCounts(tree, new Set()).size).toBe(0);
    expect(collectSubtreeLiveCounts(undefined, new Set(["x"])).size).toBe(0);
  });

  it("does not infinite-loop on a cyclic parent chain", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    const counts = collectSubtreeLiveCounts(cyclic, new Set(["a"]));
    // a -> b counted once; the cycle back to a is guarded by the seen set.
    expect(counts.get("b")).toBe(1);
    expect(counts.has("a")).toBe(false);
  });
});
