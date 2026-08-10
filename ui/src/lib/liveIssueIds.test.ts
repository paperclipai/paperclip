import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { collectLiveIssueIds, collectSubtreeLiveCounts } from "./liveIssueIds";

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
