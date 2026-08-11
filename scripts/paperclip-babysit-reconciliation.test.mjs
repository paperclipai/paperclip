import { describe, expect, it } from "vitest";
import { changesRequestedRepairSql, reconcileChangesRequested, shouldRepairChangesRequested } from "./paperclip-babysit-reconciliation.mjs";

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
    expect(sql).toContain("issues.company_id = $1");
    expect(sql).toContain("issues.id = $2");
    expect(sql).toContain("returnAssignee'->>'type' = 'agent'");
    expect(sql).toContain("return_agent.company_id = issues.company_id");
    expect(sql).toContain("execution_state->>'status' = 'changes_requested'");
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).toContain("activity_log");
    expect(sql).toContain("recovery.changes_requested_participant_repaired");
  });

  it("executes the reviewed subject-bound SQL with explicit identity", () => {
    const calls = [];
    const result = reconcileChangesRequested((sql, params) => {
      calls.push({ sql, params });
      return "issue-id";
    }, { companyId: "company-id", issueId: "issue-id" });
    expect(result).toBe("issue-id");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(["company-id", "issue-id"]);
  });

  it("rejects non-agent return principals", () => {
    expect(shouldRepairChangesRequested({
      status: "changes_requested",
      lastDecisionOutcome: "changes_requested",
      currentParticipant: { type: "agent", agentId: "lead-engineer" },
      returnAssignee: { type: "user", userId: "qa-user" },
    })).toBe(false);
  });
});
