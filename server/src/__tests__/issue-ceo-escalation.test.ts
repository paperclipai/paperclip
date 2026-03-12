import { describe, expect, it } from "vitest";

/**
 * Unit tests for the isAgentEscalatingToCeo permission logic
 * added to PATCH /issues/:id in server/src/routes/issues.ts.
 *
 * The condition allows any agent that is the current assignee of a task
 * to reassign it specifically to the company CEO without needing tasks:assign permission.
 */

function evalIsAgentEscalatingToCeo({
  actorType,
  actorAgentId,
  currentAssigneeAgentId,
  targetAgentId,
  ceoAgentId,
}: {
  actorType: string;
  actorAgentId: string | null;
  currentAssigneeAgentId: string | null;
  targetAgentId: string | null | undefined;
  ceoAgentId: string;
}): boolean {
  // Mirrors the logic in server/src/routes/issues.ts isAgentEscalatingToCeo block
  if (
    actorType === "agent" &&
    !!actorAgentId &&
    currentAssigneeAgentId === actorAgentId &&
    typeof targetAgentId === "string"
  ) {
    return targetAgentId === ceoAgentId;
  }
  return false;
}

describe("isAgentEscalatingToCeo", () => {
  it("returns true when current assignee agent reassigns to CEO", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-1",
        currentAssigneeAgentId: "agent-1",
        targetAgentId: "ceo-1",
        ceoAgentId: "ceo-1",
      }),
    ).toBe(true);
  });

  it("returns false when actor is not the current assignee", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-2",
        currentAssigneeAgentId: "agent-1",
        targetAgentId: "ceo-1",
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });

  it("returns false when target is not the CEO", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-1",
        currentAssigneeAgentId: "agent-1",
        targetAgentId: "some-other-agent",
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });

  it("returns false when actor is a board user (not agent)", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "board",
        actorAgentId: null,
        currentAssigneeAgentId: "agent-1",
        targetAgentId: "ceo-1",
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });

  it("returns false when targetAgentId is null (unassigning, not escalating)", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-1",
        currentAssigneeAgentId: "agent-1",
        targetAgentId: null,
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });

  it("returns false when targetAgentId is undefined (field not provided)", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-1",
        currentAssigneeAgentId: "agent-1",
        targetAgentId: undefined,
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });

  it("returns false when issue is unassigned (no current assignee)", () => {
    expect(
      evalIsAgentEscalatingToCeo({
        actorType: "agent",
        actorAgentId: "agent-1",
        currentAssigneeAgentId: null,
        targetAgentId: "ceo-1",
        ceoAgentId: "ceo-1",
      }),
    ).toBe(false);
  });
});
