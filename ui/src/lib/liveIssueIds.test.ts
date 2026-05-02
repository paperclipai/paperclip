import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { collectLiveIssueIds } from "./liveIssueIds";

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
});
