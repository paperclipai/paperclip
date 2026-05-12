import { describe, expect, it } from "vitest";
import { buildAutonomousGoalLoopWatchdogPreview } from "../services/autonomous-loop-watchdog-preview.ts";

const baseIssue = {
  id: "parent-issue-1",
  companyId: "company-1",
  projectId: "project-1",
  goalId: "goal-1",
  title: "Ship autonomous creator traffic ops workflow",
  priority: "high",
  status: "in_progress",
  assigneeAgentId: "agent-ceo",
  assigneeUserId: null,
  requestDepth: 0,
  executionPolicy: {
    missionControl: {
      enabled: true,
      riskClass: "high",
      requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
      acceptedValidatorVerdicts: ["PASS"],
      liveActionGate: "board",
      destructiveActionGate: "board",
      autonomousLoop: {
        enabled: true,
        controller: "CEO",
        goal: "Ship autonomous creator traffic ops workflow",
        startedAt: "2026-05-11T08:00:00.000Z",
        iteration: 2,
        maxIterations: 5,
        maxRuntimeHours: 24,
        maxDecisionAgeMinutes: 30,
      },
    },
  },
};

function docsWithDecision(decision: Record<string, unknown>, updatedAt = "2026-05-11T09:45:00.000Z") {
  return [
    { key: "validation-contract", body: "objective/pass criteria" },
    { key: "worker-handoff", body: "completed/checks" },
    { key: "validator-report", body: "Verdict: PASS" },
    { key: "ceo-loop-decision", body: JSON.stringify(decision), updatedAt },
  ];
}

describe("autonomous loop watchdog preview", () => {
  it("surfaces stale CEO decisions as operator-owned repair candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:30:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: docsWithDecision(
            {
              version: 1,
              iteration: 2,
              decision: "next_iteration",
              decisionWrittenAt: "2026-05-11T09:00:00.000Z",
              rationale: "Continue with a safe internal task.",
              nextTask: {
                title: "Repair preview",
                acceptanceCriteria: ["Preview shows repair candidate"],
                safeToRunWithoutUserApproval: true,
              },
              evidence: ["validator-report PASS"],
            },
            "2026-05-11T09:00:00.000Z",
          ),
        },
      ],
    });

    expect(preview).toMatchObject({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:30:00.000Z",
      totalIssuesScanned: 1,
    });
    expect(preview.candidates).toEqual([
      expect.objectContaining({
        id: "parent-issue-1:repair_loop_decision:ceo_loop_decision_stale",
        kind: "loop_decision_repair",
        severity: "high",
        owner: "operator",
        issueId: "parent-issue-1",
        reason: "ceo_loop_decision_stale",
        recoveryAction: "repair_loop_decision",
        userVisible: false,
      }),
    ]);
    expect(preview.candidates[0]).not.toHaveProperty("metricKey");
    expect(preview.candidates[0]?.recommendedAction).toContain("ceo-loop-decision");
  });

  it("does not launder user approval requests into operator repair candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:00:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: docsWithDecision({
            version: 1,
            iteration: 2,
            decision: "approval_required",
            rationale: "Production deploy needs explicit user approval.",
            hardGate: {
              required: true,
              reason: "Production deploy",
              category: "production_deploy",
            },
            evidence: ["deploy requested"],
          }),
        },
      ],
    });

    expect(preview.candidates).toEqual([]);
  });

  it("surfaces missing CEO loop decisions as operator manual-review candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:00:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: [
            { key: "validation-contract", body: "objective/pass criteria" },
            { key: "worker-handoff", body: "completed/checks" },
            { key: "validator-report", body: "Verdict: PASS" },
          ],
        },
      ],
    });

    expect(preview.candidates).toEqual([
      expect.objectContaining({
        id: "parent-issue-1:manual_review:missing_ceo_loop_decision",
        kind: "loop_manual_review",
        severity: "medium",
        owner: "operator",
        reason: "missing_ceo_loop_decision",
        recoveryAction: "manual_review",
        userVisible: false,
      }),
    ]);
    expect(preview.candidates[0]).not.toHaveProperty("metricKey");
  });
});
