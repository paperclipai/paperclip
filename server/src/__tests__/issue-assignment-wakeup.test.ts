import { describe, expect, it, vi } from "vitest";
import {
  buildIssueWakeContextSnapshot,
  queueIssueAssignmentWakeup,
  queueIssueWakeup,
} from "../services/issue-assignment-wakeup.js";

describe("buildIssueWakeContextSnapshot", () => {
  it("includes task title and body for adapter prompts", () => {
    expect(
      buildIssueWakeContextSnapshot(
        {
          id: "issue-1",
          identifier: "HER-2",
          title: "Smoke test worker",
          description: "Post AGENT_OK and then mark the issue done.",
        },
        "issue.create",
      ),
    ).toEqual(
      expect.objectContaining({
        issueId: "issue-1",
        taskId: "issue-1",
        issueIdentifier: "HER-2",
        taskTitle: "Smoke test worker",
        issueTitle: "Smoke test worker",
        taskBody: "Post AGENT_OK and then mark the issue done.",
        issueDescription: "Post AGENT_OK and then mark the issue done.",
        source: "issue.create",
      }),
    );
  });
});

describe("queueIssueAssignmentWakeup", () => {
  it("passes title and description through to the wake context snapshot", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "issue-1",
        identifier: "HER-2",
        title: "Smoke test worker",
        description: "Post AGENT_OK and then mark the issue done.",
        assigneeAgentId: "agent-1",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "issue_assigned",
        contextSnapshot: expect.objectContaining({
          issueId: "issue-1",
          taskId: "issue-1",
          taskTitle: "Smoke test worker",
          taskBody: "Post AGENT_OK and then mark the issue done.",
          source: "issue.create",
        }),
      }),
    );
  });
});

describe("queueIssueWakeup", () => {
  it("supports parent issue wakes with child completion context", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);

    await queueIssueWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "parent-1",
        identifier: "HER-2",
        title: "Manager delegation",
        description: "Wait for the worker to finish and then close this issue.",
        assigneeAgentId: "manager-1",
        status: "todo",
      },
      source: "automation",
      reason: "child_issue_completed",
      contextSource: "issue.child_completed",
      payload: {
        issueId: "parent-1",
        childIssueId: "child-1",
        childIssueStatus: "done",
      },
      contextExtra: {
        childIssueId: "child-1",
        childIssueIdentifier: "HER-3",
        childIssueTitle: "Worker native skill",
        childIssueStatus: "done",
        wakeReason: "child_issue_completed",
      },
      requestedByActorType: "agent",
      requestedByActorId: "worker-1",
    });

    expect(wakeup).toHaveBeenCalledWith(
      "manager-1",
      expect.objectContaining({
        reason: "child_issue_completed",
        payload: expect.objectContaining({
          issueId: "parent-1",
          childIssueId: "child-1",
          childIssueStatus: "done",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "parent-1",
          taskId: "parent-1",
          taskTitle: "Manager delegation",
          taskBody: "Wait for the worker to finish and then close this issue.",
          childIssueId: "child-1",
          childIssueIdentifier: "HER-3",
          childIssueTitle: "Worker native skill",
          childIssueStatus: "done",
          wakeReason: "child_issue_completed",
        }),
      }),
    );
  });
});
