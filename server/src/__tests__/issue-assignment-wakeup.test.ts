import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("enqueues wakeup for assigned non-backlog issues", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test",
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("normalizes forwarded issue and requester ids in wakeup payload", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: " 11111111-1111-4111-8111-111111111111 ".toUpperCase(),
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
      requestedByActorType: "agent",
      requestedByActorId: " 33333333-3333-4333-8333-333333333333 ".toUpperCase(),
    });

    expect(wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        requestedByActorId: "33333333-3333-4333-8333-333333333333",
        payload: expect.objectContaining({ issueId: "11111111-1111-4111-8111-111111111111" }),
        contextSnapshot: expect.objectContaining({ issueId: "11111111-1111-4111-8111-111111111111" }),
      }),
    );
  });

  it("skips wakeup when the assigned agent triggered the assignment", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: agentId,
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup when agent ids match with case/whitespace differences", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: agentId.toUpperCase(),
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
      requestedByActorType: "agent",
      requestedByActorId: `  ${agentId}  `,
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup for terminal issue statuses", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        status: "done",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup for terminal statuses with mixed case/whitespace", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        status: "  DoNe  ",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup when assignee id is whitespace-only", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        assigneeAgentId: "   ",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips wakeup when issue id is missing/whitespace", async () => {
    const wakeup = vi.fn(async () => undefined);

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: {
        id: "   " as any,
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
        status: "todo",
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "test",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });
});
