import { describe, expect, it } from "vitest";
import { pickAssignedIssueWakeupCandidates } from "../services/heartbeat.ts";

describe("pickAssignedIssueWakeupCandidates", () => {
  it("prefers in_progress over todo for the same agent", () => {
    const picked = pickAssignedIssueWakeupCandidates([
      {
        id: "todo-1",
        assigneeAgentId: "agent-a",
        status: "todo",
        updatedAt: new Date("2026-03-26T18:00:00.000Z"),
        createdAt: new Date("2026-03-26T18:00:00.000Z"),
      },
      {
        id: "in-progress-1",
        assigneeAgentId: "agent-a",
        status: "in_progress",
        updatedAt: new Date("2026-03-26T18:05:00.000Z"),
        createdAt: new Date("2026-03-26T18:05:00.000Z"),
      },
      {
        id: "todo-2",
        assigneeAgentId: "agent-b",
        status: "todo",
        updatedAt: new Date("2026-03-26T18:10:00.000Z"),
        createdAt: new Date("2026-03-26T18:10:00.000Z"),
      },
    ]);

    expect(picked).toHaveLength(2);
    expect(picked.map((issue) => issue.id)).toEqual(["in-progress-1", "todo-2"]);
  });

  it("uses the oldest stale issue when an agent has multiple issues in the same status", () => {
    const picked = pickAssignedIssueWakeupCandidates([
      {
        id: "todo-newer",
        assigneeAgentId: "agent-a",
        status: "todo",
        updatedAt: new Date("2026-03-26T18:10:00.000Z"),
        createdAt: new Date("2026-03-26T18:10:00.000Z"),
      },
      {
        id: "todo-older",
        assigneeAgentId: "agent-a",
        status: "todo",
        updatedAt: new Date("2026-03-26T18:00:00.000Z"),
        createdAt: new Date("2026-03-26T18:00:00.000Z"),
      },
    ]);

    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe("todo-older");
  });

  it("skips unassigned rows", () => {
    const picked = pickAssignedIssueWakeupCandidates([
      {
        id: "unassigned",
        assigneeAgentId: null,
        status: "in_progress",
        updatedAt: new Date("2026-03-26T18:00:00.000Z"),
        createdAt: new Date("2026-03-26T18:00:00.000Z"),
      },
      {
        id: "assigned",
        assigneeAgentId: "agent-a",
        status: "todo",
        updatedAt: new Date("2026-03-26T18:01:00.000Z"),
        createdAt: new Date("2026-03-26T18:01:00.000Z"),
      },
    ]);

    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe("assigned");
  });
});
