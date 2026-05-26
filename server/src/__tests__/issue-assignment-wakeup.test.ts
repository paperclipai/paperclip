import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("does not invoke heartbeat wakeup when assigneeAgentId is null", async () => {
    const wakeup = vi.fn(async () => undefined);
    await Promise.resolve(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
        reason: "issue_assigned",
        mutation: "patch",
        contextSource: "issue.patch.test",
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      }),
    );
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not invoke heartbeat wakeup when issue status is backlog", async () => {
    const wakeup = vi.fn(async () => undefined);
    await Promise.resolve(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: {
          id: "issue-1",
          assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "backlog",
        },
        reason: "issue_assigned",
        mutation: "patch",
        contextSource: "issue.patch.test",
      }),
    );
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("invokes wakeup for agent assignee on active status", async () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wakeup = vi.fn(async () => undefined);
    await Promise.resolve(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: "issue-1", assigneeAgentId: agentId, status: "todo" },
        reason: "issue_assigned",
        mutation: "patch",
        contextSource: "issue.patch.test",
      }),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "assignment",
        payload: { issueId: "issue-1", mutation: "patch" },
      }),
    );
  });

  it("merges payloadExtras and contextSnapshotExtras into wakeup options", async () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wakeup = vi.fn(async () => undefined);
    await Promise.resolve(
      queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: "issue-1", assigneeAgentId: agentId, status: "todo" },
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "issue.update",
        payloadExtras: { commentId: "c1" },
        contextSnapshotExtras: { taskId: "issue-1", commentId: "c1" },
      }),
    );
    expect(wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        payload: { issueId: "issue-1", mutation: "update", commentId: "c1" },
        contextSnapshot: { issueId: "issue-1", source: "issue.update", taskId: "issue-1", commentId: "c1" },
      }),
    );
  });
});
