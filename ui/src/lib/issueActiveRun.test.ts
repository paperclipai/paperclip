import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { filterIssueLiveRuns, resolveIssueActiveRun, shouldTrackIssueActiveRun } from "./issueActiveRun";

describe("issueActiveRun", () => {
  const makeIssue = (
    overrides: Partial<Pick<Issue, "status" | "executionRunId">>,
  ): Pick<Issue, "status" | "executionRunId"> => ({
    status: "todo",
    executionRunId: null,
    ...overrides,
  });

  it("tracks active runs while an issue is still in progress", () => {
    expect(shouldTrackIssueActiveRun(makeIssue({ status: "in_progress" }))).toBe(true);
  });

  it("does not track active runs after an issue reaches a terminal state", () => {
    expect(shouldTrackIssueActiveRun(makeIssue({ status: "done", executionRunId: "run-123" }))).toBe(false);
    expect(shouldTrackIssueActiveRun(makeIssue({ status: "cancelled", executionRunId: "run-123" }))).toBe(false);
  });

  it("drops stale cached active runs once the issue is closed and unlocked", () => {
    const staleActiveRun: ActiveRunForIssue = {
      id: "run-123",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: "2026-04-13T01:29:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-13T01:29:00.000Z",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      issueId: "issue-1",
    };

    expect(
      resolveIssueActiveRun(
        makeIssue({ status: "done" }),
        staleActiveRun,
      ),
    ).toBeNull();
  });

  it("drops live runs for terminal issues and unscoped agent runs", () => {
    const issue = { id: "issue-1", status: "todo" } as Pick<Issue, "id" | "status">;
    const runs: LiveRunForIssue[] = [
      {
        id: "run-1",
        status: "running",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: "2026-04-13T01:29:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-13T01:29:00.000Z",
        agentId: "agent-1",
        agentName: "Builder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
      {
        id: "run-2",
        status: "queued",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-04-13T01:30:00.000Z",
        agentId: "agent-1",
        agentName: "Builder",
        adapterType: "codex_local",
        issueId: null,
      },
    ];

    expect(filterIssueLiveRuns(issue, runs).map((run) => run.id)).toEqual(["run-1"]);
    expect(filterIssueLiveRuns({ ...issue, status: "done" }, runs)).toEqual([]);
  });
});
