import { describe, expect, it } from "vitest";
import {
  EXECUTION_GRANT_POLICY_VERSION,
  executionGrantDenial,
  executionGrantRequestHash,
  type ExecutionGrant,
  type ExecutionGrantAttempt,
} from "./execution-grant-contract.js";

const grant: ExecutionGrant = {
  companyId: "company",
  issueId: "issue",
  proposerAgentId: "proposer",
  executorAgentId: "executor",
  targetAgentId: "chief",
  operation: "agent_config:update",
  targetRevisionId: "revision-1",
  requestHash: executionGrantRequestHash("PATCH", "/api/agents/chief", { name: "Chief of staff" }),
  expiresAt: new Date("2026-09-28T00:00:00Z"),
  policyVersion: EXECUTION_GRANT_POLICY_VERSION,
  decision: { kind: "agent", decisionId: "decision", approverAgentId: "steward" },
  consumedAt: null,
};
const attempt: ExecutionGrantAttempt = {
  companyId: "company",
  executorAgentId: "executor",
  targetAgentId: "chief",
  operation: "agent_config:update",
  targetRevisionId: "revision-1",
  requestHash: grant.requestHash,
  decisionStewardAgentId: "steward",
  currentPolicyVersion: EXECUTION_GRANT_POLICY_VERSION,
  now: new Date("2026-09-27T00:00:00Z"),
};

describe("execution grant contract", () => {
  it("accepts one exact steward-approved Chief of staff config request by a distinct executor", () => {
    expect(executionGrantDenial(grant, attempt)).toBeNull();
    expect(executionGrantDenial({ ...grant, consumedAt: attempt.now }, attempt)).toBe("already_consumed");
  });

  it.each([
    ["self approval", { decision: { kind: "agent", decisionId: "decision", approverAgentId: "proposer" } }, {}, "self_approval"],
    ["approver execution", { executorAgentId: "steward" }, { executorAgentId: "steward" }, "approver_is_executor"],
    ["proposer execution", { executorAgentId: "proposer" }, { executorAgentId: "proposer" }, "proposer_is_executor"],
    ["changed payload", {}, { requestHash: "different" }, "request_changed"],
    ["stale target", {}, { targetRevisionId: "revision-2" }, "stale_target"],
    ["expired grant", {}, { now: grant.expiresAt }, "expired"],
    ["unauthorized executor", {}, { executorAgentId: "other" }, "unauthorized_executor"],
    ["Steward powers", { targetAgentId: "steward" }, { targetAgentId: "steward" }, "steward_powers"],
    ["old policy", { policyVersion: 0 }, {}, "policy_version_changed"],
    ["another company", {}, { companyId: "other" }, "company_mismatch"],
  ] as const)("denies %s", (_name, grantPatch, attemptPatch, reason) => {
    expect(executionGrantDenial(
      { ...grant, ...grantPatch } as ExecutionGrant,
      { ...attempt, ...attemptPatch } as ExecutionGrantAttempt,
    )).toBe(reason);
  });

  it("denies proposer execution of a board-approved grant", () => {
    expect(executionGrantDenial({ ...grant, executorAgentId: "proposer",
      decision: { kind: "board", decisionId: "board-decision", approverUserId: "board-user" },
    }, { ...attempt, executorAgentId: "proposer" })).toBe("proposer_is_executor");
  });

  it("uses a canonical hash and binds the HTTP method and path", () => {
    const expected = executionGrantRequestHash("PATCH", "/api/agents/chief", {
      adapterConfig: { model: "gpt-6-sol", provider: "openai" }, name: "Chief of staff",
    });
    expect(executionGrantRequestHash("patch", "/api/agents/chief", {
      name: "Chief of staff", adapterConfig: { provider: "openai", model: "gpt-6-sol" },
    })).toBe(expected);
    expect(executionGrantRequestHash("PUT", "/api/agents/chief", {})).not.toBe(expected);
    expect(executionGrantRequestHash("PATCH", "/api/agents/other", {})).not.toBe(expected);
  });
});
