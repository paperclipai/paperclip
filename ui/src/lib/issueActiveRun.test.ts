import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { resolveIssueActiveRun, shouldTrackIssueActiveRun } from "./issueActiveRun";

describe("issueActiveRun", () => {
  const makeIssue = (
    overrides: Partial<Pick<Issue, "status" | "executionRunId">>,
  ): Pick<Issue, "status" | "executionRunId"> => ({
    status: "todo",
    executionRunId: null,
    ...overrides,
  });

  it("refreshes the selected run from the polled list after startup confirmation", () => {
    const issue = makeIssue({ status: "in_progress", executionRunId: "run-1" });
    const initialRun = {
      id: "run-1",
      status: "running",
      execution: { phase: "reconnecting", label: "Confirming execution" },
    } as ActiveRunForIssue;
    const refreshedRun = {
      ...initialRun,
      execution: { phase: "working", label: "Working" },
      currentToolName: "Read file",
    } as LiveRunForIssue;
    const otherRun = { ...refreshedRun, id: "run-2" };

    expect(resolveIssueActiveRun(issue, initialRun)).toBe(initialRun);
    expect(resolveIssueActiveRun(issue, initialRun, [otherRun, refreshedRun])).toBe(refreshedRun);
    expect(resolveIssueActiveRun(issue, initialRun, [otherRun])).toBe(initialRun);
    expect(resolveIssueActiveRun(issue, null, [refreshedRun])).toBe(refreshedRun);
    expect(resolveIssueActiveRun(makeIssue({ status: "done" }), initialRun, [refreshedRun])).toBeNull();
  });

  it("selects the task's replacement run instead of the cached predecessor", () => {
    const issue = makeIssue({ status: "in_progress", executionRunId: "run-new" });
    const oldRun = { id: "run-old", status: "running" } as LiveRunForIssue;
    const newRun = { id: "run-new", status: "running" } as LiveRunForIssue;

    expect(resolveIssueActiveRun(issue, oldRun, [oldRun, newRun])).toBe(newRun);
    expect(resolveIssueActiveRun(issue, oldRun, [oldRun])).toBeNull();
    expect(resolveIssueActiveRun(issue, oldRun)).toBeNull();
    expect(resolveIssueActiveRun(issue, null, [newRun])).toBe(newRun);
    expect(resolveIssueActiveRun(makeIssue({ status: "in_progress" }), oldRun, [oldRun, newRun])).toBe(oldRun);
  });

  it("tracks active runs while an issue is still in progress", () => {
    expect(shouldTrackIssueActiveRun(makeIssue({ status: "in_progress" }))).toBe(true);
  });

  it("tracks active runs while an execution run id is still attached", () => {
    expect(shouldTrackIssueActiveRun(makeIssue({ status: "done", executionRunId: "run-123" }))).toBe(true);
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
});
