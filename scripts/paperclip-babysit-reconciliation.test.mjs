import { describe, expect, it } from "vitest";
import { changesRequestedRepairSql, shouldRepairChangesRequested } from "./paperclip-babysit-reconciliation.mjs";

describe("changes-requested reconciliation", () => {
  it("does not overwrite a restored pending reviewer", () => {
    expect(shouldRepairChangesRequested({
      status: "pending",
      lastDecisionOutcome: "changes_requested",
      currentParticipant: { type: "agent", agentId: "lead-engineer" },
      returnAssignee: { type: "agent", agentId: "qa" },
    })).toBe(false);
  });

  it("repairs only a live changes-requested state", () => {
    expect(shouldRepairChangesRequested({
      status: "changes_requested",
      lastDecisionOutcome: "changes_requested",
      currentParticipant: { type: "agent", agentId: "lead-engineer" },
      returnAssignee: { type: "agent", agentId: "qa" },
    })).toBe(true);
  });

  it("uses a compare-and-set predicate in the reviewed SQL", () => {
    const sql = changesRequestedRepairSql();
    expect(sql).toContain("execution_state->>'status' = 'changes_requested'");
    expect(sql).toContain("IS DISTINCT FROM");
  });
});
