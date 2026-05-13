import { describe, it, expect } from "vitest";
import {
  classifyTaskRisk,
  isHardBlockedContext,
  evaluateProviderFallbackEligibility,
  buildDefaultPolicy,
  type TaskClassificationContext,
} from "../services/provider-routing-policy.js";

describe("classifyTaskRisk", () => {
  const baseAgent = { role: "engineer", adapterConfig: {} };
  const emptyCtx: TaskClassificationContext = {};

  it("classifies approval context as governance", () => {
    expect(classifyTaskRisk(baseAgent, { approvalId: "abc" }, null)).toBe("governance");
    expect(classifyTaskRisk(baseAgent, { approvalStatus: "pending" }, null)).toBe("governance");
  });

  it("classifies governance wake reasons as governance", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "approval_requested")).toBe("governance");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "permission_escalation")).toBe("governance");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "policy_review")).toBe("governance");
  });

  it("classifies SSH / deployment context as infrastructure", () => {
    expect(classifyTaskRisk(baseAgent, { executionTargetType: "ssh" }, null)).toBe("infrastructure");
    expect(classifyTaskRisk(baseAgent, { deploymentId: "d-1" }, null)).toBe("infrastructure");
    expect(classifyTaskRisk(baseAgent, { executionTransport: {} }, null)).toBe("infrastructure");
  });

  it("classifies deployment wake reasons as deployment", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "deploy_staging")).toBe("deployment");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "release_candidate")).toBe("deployment");
  });

  it("classifies dangerous adapter config as infrastructure", () => {
    const agent = { role: "engineer", adapterConfig: { dangerouslySkipPermissions: true } };
    expect(classifyTaskRisk(agent, emptyCtx, "some_task")).toBe("infrastructure");
  });

  it("classifies financial wake reasons as financial", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "wallet_check")).toBe("financial");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "billing_reconciliation")).toBe("financial");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "budget_review")).toBe("financial");
  });

  it("classifies monitoring wake reasons as monitoring", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "heartbeat_check")).toBe("monitoring");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "liveness_probe")).toBe("monitoring");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "watchdog_scan")).toBe("monitoring");
  });

  it("classifies reporting wake reasons as reporting", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "trust_score_update")).toBe("reporting");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "evaluate_findings")).toBe("reporting");
  });

  it("classifies drafting wake reasons as drafting", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "draft_content")).toBe("drafting");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "compose_report")).toBe("drafting");
  });

  it("classifies qa/researcher roles as safe_readonly", () => {
    expect(classifyTaskRisk({ role: "qa", adapterConfig: {} }, emptyCtx, "generic_task")).toBe("safe_readonly");
    expect(classifyTaskRisk({ role: "researcher", adapterConfig: {} }, emptyCtx, "generic_task")).toBe("safe_readonly");
  });

  it("defaults to governance for unknown tasks (fail-closed)", () => {
    expect(classifyTaskRisk(baseAgent, emptyCtx, "something_unknown")).toBe("governance");
    expect(classifyTaskRisk(baseAgent, emptyCtx, null)).toBe("governance");
    expect(classifyTaskRisk(baseAgent, emptyCtx, "")).toBe("governance");
  });

  it("respects precedence: governance context beats monitoring wake reason", () => {
    expect(classifyTaskRisk(baseAgent, { approvalId: "abc" }, "heartbeat_check")).toBe("governance");
  });
});

describe("isHardBlockedContext", () => {
  const baseAgent = { adapterConfig: {} };

  it("blocks board approvals", () => {
    const result = isHardBlockedContext({ approvalId: "abc" }, null, baseAgent);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("board_approval");
  });

  it("blocks credential handling", () => {
    const result = isHardBlockedContext({ secretRef: "ref" }, null, baseAgent);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("credential_handling");
  });

  it("blocks SSH execution", () => {
    const result = isHardBlockedContext({ executionTargetType: "ssh" }, null, baseAgent);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("ssh_execution");
  });

  it("blocks deployment tasks", () => {
    const result = isHardBlockedContext({ deploymentId: "d-1" }, null, baseAgent);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("deployment_task");
  });

  it("blocks dangerouslyBypassSandbox", () => {
    const agent = { adapterConfig: { dangerouslyBypassSandbox: true } };
    const result = isHardBlockedContext({}, null, agent);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("infrastructure_mutation");
  });

  it("blocks hard-blocked wake reasons", () => {
    expect(isHardBlockedContext({}, "wallet_transfer", baseAgent).blocked).toBe(true);
    expect(isHardBlockedContext({}, "permission_grant", baseAgent).blocked).toBe(true);
    expect(isHardBlockedContext({}, "governance_review", baseAgent).blocked).toBe(true);
    expect(isHardBlockedContext({}, "deploy_production", baseAgent).blocked).toBe(true);
  });

  it("does not block safe contexts", () => {
    expect(isHardBlockedContext({}, "heartbeat_check", baseAgent).blocked).toBe(false);
    expect(isHardBlockedContext({}, "trust_score", baseAgent).blocked).toBe(false);
    expect(isHardBlockedContext({}, null, baseAgent).blocked).toBe(false);
  });
});

describe("evaluateProviderFallbackEligibility", () => {
  const policy = buildDefaultPolicy({ enabled: true, stage: 3 });

  it("denies agents not in allowlist", () => {
    const agent = { name: "Random Agent", role: "engineer" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "heartbeat_check", policy);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("agent_not_in_allowlist");
  });

  it("denies denied roles even if name is in allowlist", () => {
    const agent = { name: "TrustScore", role: "ceo" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "heartbeat_check", policy);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/^agent_role_denied/);
  });

  it("denies hard-blocked contexts even for allowed agents", () => {
    const agent = { name: "TrustScore", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, { approvalId: "abc" }, "heartbeat_check", policy);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/^context_hard_blocked/);
  });

  it("denies disallowed task-risk classes", () => {
    const agent = { name: "TrustScore", role: "qa" };
    // "budget_review" matches financial risk class, which is denied
    const result = evaluateProviderFallbackEligibility(agent, {}, "budget_review", policy);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/^task_risk_denied:financial/);
  });

  it("hard-blocks deploy contexts even for allowed agents", () => {
    const agent = { name: "TrustScore", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "deploy_production", policy);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/^context_hard_blocked/);
  });

  it("approves eligible agents with safe task-risk", () => {
    const agent = { name: "TrustScore", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "trust_score_update", policy);
    expect(result.eligible).toBe(true);
    expect(result.taskRiskClass).toBe("reporting");
  });

  it("approves WatchDog with monitoring task", () => {
    const agent = { name: "WatchDog", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "heartbeat_check", policy);
    expect(result.eligible).toBe(true);
    expect(result.taskRiskClass).toBe("monitoring");
  });

  it("approves Content Strategist with drafting task", () => {
    const agent = { name: "Content Strategist", role: "general" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "draft_content", policy);
    expect(result.eligible).toBe(true);
    expect(result.taskRiskClass).toBe("drafting");
  });

  it("is case-insensitive for agent name matching", () => {
    const agent = { name: "TRUSTSCORE", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "trust_score_update", policy);
    expect(result.eligible).toBe(true);
  });

  it("defaults unknown tasks to governance for non-readonly roles (fail-closed)", () => {
    const agent = { name: "TrustScore", role: "general" };
    const policyWithGeneral = {
      ...policy,
      allowedAgentNames: new Set(["trustscore"]),
    };
    const result = evaluateProviderFallbackEligibility(agent, {}, "unknown_task", policyWithGeneral);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("task_risk_denied:governance");
  });

  it("qa role with unknown wake reason classifies as safe_readonly (allowed)", () => {
    const agent = { name: "TrustScore", role: "qa" };
    const result = evaluateProviderFallbackEligibility(agent, {}, "unknown_task", policy);
    expect(result.eligible).toBe(true);
    expect(result.taskRiskClass).toBe("safe_readonly");
  });
});
