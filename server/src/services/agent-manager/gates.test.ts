import { describe, expect, it } from "vitest";
import { shouldEvaluateRun } from "./gates.js";
import type { CompanyAgentManagerSettingsRow } from "./types.js";

const baseSettings: CompanyAgentManagerSettingsRow = {
  enabled: true,
  supervisorAgentId: "supervisor-1",
  escalationAgentId: null,
  judgeModelProfile: "cheap",
  scoreThreshold: 70,
  maxReflectionAttempts: 3,
  evaluateFailedRuns: true,
  evaluateNeedsFollowup: true,
};

describe("agent manager gates", () => {
  it("allows standard succeeded runs when all gates pass", () => {
    expect(shouldEvaluateRun({
      companyId: "c1",
      issueId: "i1",
      runId: "r1",
      agentId: "a1",
      trigger: "run_succeeded",
      issueWorkMode: "standard",
      settings: baseSettings,
      hasActiveRecovery: false,
      hasExistingEvaluation: false,
      assigneeBudgetBlocked: false,
      supervisedAgentExcluded: false,
    })).toBe(true);
  });

  it("skips when company agent manager is disabled", () => {
    expect(shouldEvaluateRun({
      companyId: "c1",
      issueId: "i1",
      runId: "r1",
      agentId: "a1",
      trigger: "run_succeeded",
      issueWorkMode: "standard",
      settings: { ...baseSettings, enabled: false },
      hasActiveRecovery: false,
      hasExistingEvaluation: false,
      assigneeBudgetBlocked: false,
      supervisedAgentExcluded: false,
    })).toBe(false);
  });

  it("skips skill_test work mode", () => {
    expect(shouldEvaluateRun({
      companyId: "c1",
      issueId: "i1",
      runId: "r1",
      agentId: "a1",
      trigger: "run_succeeded",
      issueWorkMode: "skill_test",
      settings: baseSettings,
      hasActiveRecovery: false,
      hasExistingEvaluation: false,
      assigneeBudgetBlocked: false,
      supervisedAgentExcluded: false,
    })).toBe(false);
  });

  it("skips when recovery owns the issue", () => {
    expect(shouldEvaluateRun({
      companyId: "c1",
      issueId: "i1",
      runId: "r1",
      agentId: "a1",
      trigger: "run_succeeded",
      issueWorkMode: "standard",
      settings: baseSettings,
      hasActiveRecovery: true,
      hasExistingEvaluation: false,
      assigneeBudgetBlocked: false,
      supervisedAgentExcluded: false,
    })).toBe(false);
  });

  it("allows needs_followup trigger when configured", () => {
    expect(shouldEvaluateRun({
      companyId: "c1",
      issueId: "i1",
      runId: "r1",
      agentId: "a1",
      trigger: "needs_followup",
      issueWorkMode: "standard",
      settings: baseSettings,
      hasActiveRecovery: false,
      hasExistingEvaluation: false,
      assigneeBudgetBlocked: false,
      supervisedAgentExcluded: false,
    })).toBe(true);
  });
});
