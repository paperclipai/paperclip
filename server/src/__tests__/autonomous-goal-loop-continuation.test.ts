import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
  buildAutonomousGoalLoopContinuationPlan,
  buildAutonomousGoalLoopState,
} from "../services/autonomous-goal-loop-continuation.ts";

const parentIssue = {
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
        iteration: 1,
        maxIterations: 5,
        maxRuntimeHours: 24,
      },
    },
  },
};

function missionDocsWithDecision(decision: Record<string, unknown>) {
  return [
    { key: "validation-contract", body: "objective/pass criteria" },
    { key: "worker-handoff", body: "completed/checks" },
    { key: "validator-report", body: "Verdict: PASS" },
    { key: "ceo-loop-decision", body: JSON.stringify(decision) },
  ];
}

describe("autonomous goal loop continuation planning", () => {
  it("plans one safe child issue for a validated next_iteration decision", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue with one more safe internal cycle.",
        nextTask: {
          title: "Add scheduler handoff smoke coverage",
          description: "Cover the automatic child creation path with a safe local test.",
          acceptanceCriteria: [
            "Child task is created from ceo-loop-decision",
            "Parent is blocked by the child until it completes",
          ],
          assigneeHint: "reuse the CEO/lead agent unless a specific worker is selected later",
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan.action).toBe("create_child");
    if (plan.action !== "create_child") throw new Error("expected create_child plan");
    expect(plan.originKind).toBe(AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND);
    expect(plan.originId).toBe(parentIssue.id);
    expect(plan.originFingerprint).toBe("iteration:1");
    expect(plan.childInput).toMatchObject({
      title: "[Loop 2] Add scheduler handoff smoke coverage",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-ceo",
      assigneeUserId: null,
      blockParentUntilDone: true,
      acceptanceCriteria: [
        "Child task is created from ceo-loop-decision",
        "Parent is blocked by the child until it completes",
      ],
      originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
      originId: parentIssue.id,
      originFingerprint: "iteration:1",
    });
    expect(plan.childInput.description).toContain("Validation passed; continue with one more safe internal cycle.");
    expect(plan.childInput.description).toContain("safe internal autonomous-loop continuation");
    expect(plan.childInput.executionPolicy).toMatchObject({
      missionControl: {
        enabled: true,
        riskClass: "high",
        requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
        acceptedValidatorVerdicts: ["PASS"],
        autonomousLoop: null,
      },
    });
  });

  it("does not create a child when required mission-control artifacts are missing", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: [
        { key: "validator-report", body: "Verdict: PASS" },
        {
          key: "ceo-loop-decision",
          body: JSON.stringify({
            version: 1,
            iteration: 1,
            decision: "next_iteration",
            rationale: "Try to continue too early.",
            nextTask: {
              title: "Premature child",
              acceptanceCriteria: ["Should not be created"],
              safeToRunWithoutUserApproval: true,
            },
            evidence: ["incomplete"],
          }),
        },
      ],
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "wait",
      reason: "missing_documents",
      reportToUser: false,
    });
  });

  it("stops for user-visible limits instead of creating another iteration child", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: {
        ...parentIssue,
        executionPolicy: {
          missionControl: {
            ...parentIssue.executionPolicy.missionControl,
            autonomousLoop: {
              ...parentIssue.executionPolicy.missionControl.autonomousLoop,
              iteration: 5,
              maxIterations: 5,
            },
          },
        },
      },
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 5,
        decision: "next_iteration",
        rationale: "Continue after hitting the limit.",
        nextTask: {
          title: "Over limit task",
          acceptanceCriteria: ["Should not be created"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "iteration_exceeded",
      reportToUser: true,
    });
  });

  it("reports approval_required decisions without creating child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "Next step requires a production deploy.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Needs explicit user approval before deploy.",
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "approval_required",
      reportToUser: true,
    });
  });

  it("blocks stale decisions whose iteration no longer matches the loop policy", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "This decision was generated before the current loop iteration.",
        nextTask: {
          title: "Repeat stale implementation slice",
          acceptanceCriteria: ["should not be created"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_iteration_mismatch",
      reportToUser: false,
    });
  });

  it("keeps stale terminal decisions internal instead of reporting them as goal reached", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "goal_reached",
        rationale: "This goal reached decision was generated for a stale iteration.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_iteration_mismatch",
      reportToUser: false,
    });
  });

  it("reports failed decisions instead of creating child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "failed",
        rationale: "Repeated validator failures made the autonomous loop unsafe to continue.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "autonomous_loop_not_complete",
      reportToUser: true,
    });
  });

  it("builds an observable loop state with planner and supervisor scaffolding", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; launch another safe internal slice.",
        nextTask: {
          title: "Expose loop state panel",
          acceptanceCriteria: ["Issue detail shows loop state"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [
        {
          id: "child-1",
          parentId: "parent-issue-1",
          identifier: "PAP-2",
          title: "[Loop 2] Expose loop state panel",
          status: "in_progress",
          originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
          originId: "parent-issue-1",
          originFingerprint: "iteration:1",
          blockedBy: [],
          createdAt: new Date("2026-05-11T09:01:00.000Z"),
          updatedAt: new Date("2026-05-11T09:05:00.000Z"),
        },
      ],
      now: "2026-05-11T09:10:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "executing",
      goal: "Ship autonomous creator traffic ops workflow",
      iteration: 1,
      maxIterations: 5,
      progressLabel: "1 / 5",
      currentDecision: {
        iteration: 1,
        decision: "next_iteration",
        nextTaskTitle: "Expose loop state panel",
      },
      planner: {
        mode: "single_child",
        supportsParallelChildren: false,
        nextTaskTitle: "Expose loop state panel",
      },
      supervisor: {
        attentionRequired: false,
        recoveryAction: "none",
      },
    });
    expect(state.iterations).toEqual([
      expect.objectContaining({
        iteration: 2,
        issueId: "child-1",
        identifier: "PAP-2",
        status: "in_progress",
      }),
    ]);
    expect(state.observability.chain).toEqual([
      expect.objectContaining({ kind: "goal", issueId: "parent-issue-1" }),
      expect.objectContaining({ kind: "iteration", issueId: "child-1", iteration: 2 }),
    ]);
  });

  it("renders stale approval decisions as an internal repair state", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const state = buildAutonomousGoalLoopState({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "This approval request belongs to a previous loop iteration.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Production deploy is user-gated.",
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "failed",
      supervisor: {
        attentionRequired: true,
        reason: "ceo_loop_iteration_mismatch",
        recoveryAction: "repair_loop_decision",
        userVisible: false,
      },
    });
  });

  it("marks approval and blocked loop states for supervisor attention", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "Need explicit approval before production deploy.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Production deploy is user-gated.",
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "approval_required",
      supervisor: {
        attentionRequired: true,
        reason: "approval_required",
        recoveryAction: "request_user_approval",
        userVisible: true,
      },
    });
  });
});
