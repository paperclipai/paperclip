import { describe, expect, it } from "vitest";
import {
  buildAutonomousGoalLoopWatchdogPreview,
  type AutonomousGoalLoopWatchdogPreview,
} from "../services/autonomous-loop-watchdog-preview.ts";
import { buildAutonomousGoalLoopWatchdogRecoveryPlanPreview } from "../services/autonomous-loop-watchdog-recovery-plan.ts";

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

const blockedActions = [
  "request_user_approval",
  "create_approval",
  "create_child_issue",
  "upsert_issue_document",
  "continue_autonomous_goal_loop",
  "queue_wakeup",
] as const;

const allFalseMutationPolicy = {
  dryRunOnly: true,
  writesDocument: false,
  createsIssue: false,
  createsApproval: false,
  queuesWakeup: false,
  continuesAutonomousLoop: false,
  liveRecovery: false,
};

describe("autonomous loop watchdog recovery plan preview", () => {
  it("builds a dry-run document repair plan for stale CEO decisions", () => {
    const watchdogPreview = buildAutonomousGoalLoopWatchdogPreview({
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

    const recoveryPlan = buildAutonomousGoalLoopWatchdogRecoveryPlanPreview({
      preview: watchdogPreview,
      generatedAt: "2026-05-11T10:31:00.000Z",
    });

    expect(recoveryPlan).toMatchObject({
      companyId: "company-1",
      mode: "recovery_plan_preview",
      dryRun: true,
      readOnly: true,
      liveRecovery: false,
      generatedAt: "2026-05-11T10:31:00.000Z",
      totalIssuesScanned: 1,
      candidatesConsidered: 1,
      guardrails: {
        boardOnly: true,
        dryRunOnly: true,
        noLiveRecovery: true,
        noApprovalLaundering: true,
        allowedOwners: ["operator"],
      },
    });
    expect(recoveryPlan.skippedCandidates).toEqual([]);
    expect(recoveryPlan.plans).toEqual([
      expect.objectContaining({
        id: "recovery-plan:parent-issue-1:repair_loop_decision:ceo_loop_decision_stale",
        candidateId: "parent-issue-1:repair_loop_decision:ceo_loop_decision_stale",
        issueId: "parent-issue-1",
        planKind: "repair_loop_decision_document",
        execution: "operator_manual_only",
        recoveryAction: "repair_loop_decision",
        mutationPolicy: allFalseMutationPolicy,
        blockedActions,
      }),
    ]);
    expect(recoveryPlan.plans[0]?.steps).toEqual([
      expect.objectContaining({ order: 1, action: "inspect_loop_state", wouldMutate: false }),
      expect.objectContaining({ order: 2, action: "inspect_mission_control_documents", wouldMutate: false }),
      expect.objectContaining({
        order: 3,
        action: "draft_operator_repair",
        target: { issueId: "parent-issue-1", documentKey: "ceo-loop-decision" },
        wouldMutate: false,
      }),
      expect.objectContaining({ order: 4, action: "operator_applies_manually", wouldMutate: false }),
    ]);
  });

  it("does not launder approval-required decisions into recovery plans", () => {
    const watchdogPreview = buildAutonomousGoalLoopWatchdogPreview({
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

    const recoveryPlan = buildAutonomousGoalLoopWatchdogRecoveryPlanPreview({ preview: watchdogPreview });

    expect(watchdogPreview.candidates).toEqual([]);
    expect(recoveryPlan.plans).toEqual([]);
    expect(recoveryPlan.skippedCandidates).toEqual([]);
    expect(JSON.stringify(recoveryPlan)).not.toContain("create_approval");
    expect(JSON.stringify(recoveryPlan)).not.toContain("request_user_approval");
  });

  it("defensively skips user-owned or approval-shaped candidates", () => {
    const preview = {
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 1,
      candidates: [
        {
          id: "issue-1:request_user_approval:approval_required",
          kind: "loop_operator_attention",
          severity: "medium",
          owner: "user",
          issueId: "issue-1",
          identifier: "PAP-581",
          title: "Needs user approval",
          status: "blocked",
          reason: "approval_required",
          recoveryAction: "request_user_approval",
          recommendedAction: "Ask the user.",
          userVisible: true,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    } as unknown as AutonomousGoalLoopWatchdogPreview;

    const recoveryPlan = buildAutonomousGoalLoopWatchdogRecoveryPlanPreview({ preview });

    expect(recoveryPlan.plans).toEqual([]);
    expect(recoveryPlan.skippedCandidates).toEqual([
      {
        candidateId: "issue-1:request_user_approval:approval_required",
        issueId: "issue-1",
        reason: "non_operator_owner",
        owner: "user",
        recoveryAction: "request_user_approval",
      },
    ]);
  });

  it("maps loop-limit candidates to manual operator review only", () => {
    const preview = {
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:00:00.000Z",
      totalIssuesScanned: 1,
      candidates: [
        {
          id: "issue-1:adjust_loop_limits_or_close_goal:iteration_exceeded",
          kind: "loop_limit_attention",
          severity: "medium",
          owner: "operator",
          issueId: "issue-1",
          identifier: "PAP-582",
          title: "Loop limit reached",
          status: "blocked",
          reason: "iteration_exceeded",
          recoveryAction: "adjust_loop_limits_or_close_goal",
          recommendedAction: "Review limits.",
          userVisible: false,
          generatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    } as AutonomousGoalLoopWatchdogPreview;

    const recoveryPlan = buildAutonomousGoalLoopWatchdogRecoveryPlanPreview({ preview });

    expect(recoveryPlan.plans).toEqual([
      expect.objectContaining({
        planKind: "review_loop_limits_or_close_goal",
        execution: "operator_manual_only",
        mutationPolicy: allFalseMutationPolicy,
        blockedActions,
      }),
    ]);
    expect(recoveryPlan.plans[0]?.steps.every((step) => step.wouldMutate === false)).toBe(true);
  });
});
