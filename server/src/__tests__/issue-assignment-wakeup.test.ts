import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

function makeHeartbeat() {
  const wakeup = vi.fn().mockResolvedValue(null);
  return { heartbeat: { wakeup }, wakeup };
}

describe("queueIssueAssignmentWakeup", () => {
  it("fires wake when issue is todo and has assignee", async () => {
    const { heartbeat, wakeup } = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("fires wake for backlog issues with assignee (default status at creation)", async () => {
    // Root cause of Bug #2: createIssueSchema defaults status to "backlog".
    // When an issue is created with an assigneeAgentId but no explicit status,
    // it gets status="backlog". The old guard `status === "backlog" → return`
    // silently blocked the wake, leaving the assignee unnotified.
    const { heartbeat, wakeup } = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-2", assigneeAgentId: "agent-2", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("skips wake when there is no assignee", async () => {
    const { heartbeat, wakeup } = makeHeartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-3", assigneeAgentId: null, status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
