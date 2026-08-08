import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue } from "../api/heartbeats";
import { resolveIssueActiveRun, shouldTrackIssueActiveRun } from "./issueActiveRun";

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
