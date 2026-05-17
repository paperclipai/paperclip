import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_OUTCOME_SCHEMA_VERSION,
  computeSharedInboxLiteAssignmentOutcome,
  enforceNonEmptyRetryWakeResult,
  evaluateWakeAssignment,
  issuesToWakeCandidates,
  parseWakeGuardrailResultJson,
  serializeWakeGuardrailResult,
} from "./wake-assignment-outcome.js";

describe("wake-assignment-outcome", () => {
  it("serializes and parses roundtrip", () => {
    const original = evaluateWakeAssignment({
      retryAttempt: 0,
      maxRetries: 2,
      candidates: [{ issueId: "a", assigneeAgentId: "agent-1" }],
    });
    const json = serializeWakeGuardrailResult(original);
    expect(parseWakeGuardrailResultJson(json)).toEqual(original);
  });

  it("computes shared inbox outcome with deterministic ordering", () => {
    const dep = new Map([
      ["i1", { unresolvedBlockerIssueIds: [] as string[] }],
      ["i2", { unresolvedBlockerIssueIds: [] as string[] }],
    ]);
    const outcome = computeSharedInboxLiteAssignmentOutcome({
      rows: [
        { id: "i2", status: "todo", assigneeAgentId: "a2" },
        { id: "i1", status: "todo", assigneeAgentId: "a1" },
      ],
      dependencyReadiness: dep,
      blockerAssigneeByIssueId: new Map(),
      retryAttempt: 0,
      maxRetries: 3,
    });
    expect(outcome.kind).toBe("issue_assigned");
    if (outcome.kind === "issue_assigned") {
      expect(outcome.issueId).toBe("i1");
      expect(outcome.assigneeAgentId).toBe("a1");
    }
  });

  it("maps blocked issues to blockedByOwnerId from dependency owners", () => {
    const dep = new Map([["blocked-1", { unresolvedBlockerIssueIds: ["blocker-x"] }]]);
    const candidates = issuesToWakeCandidates(
      [{ id: "blocked-1", status: "blocked", assigneeAgentId: null }],
      dep,
      new Map([["blocker-x", "owner-agent"]]),
    );
    expect(candidates[0]?.blockedByOwnerId).toBe("owner-agent");
    const outcome = evaluateWakeAssignment({
      retryAttempt: 0,
      maxRetries: 1,
      candidates,
    });
    expect(outcome.kind).toBe("blocked_with_owner");
  });

  it("maps dependency blocker owners for non-blocked rows when unresolved blockers exist", () => {
    const dep = new Map([["i1", { unresolvedBlockerIssueIds: ["b1"] }]]);
    const candidates = issuesToWakeCandidates(
      [{ id: "i1", status: "todo", assigneeAgentId: "self" }],
      dep,
      new Map([["b1", "owner-a"]]),
    );
    expect(candidates[0]?.blockedByOwnerId).toBe("owner-a");
  });

  it("enforceNonEmptyRetryWakeResult covers null", () => {
    const r = enforceNonEmptyRetryWakeResult(null, 2);
    expect(r.schemaVersion).toBe(ASSIGNMENT_OUTCOME_SCHEMA_VERSION);
    expect(r.kind).toBe("idle_with_reason");
  });
});
