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

function missionDocsWithDecision(
  decision: Record<string, unknown>,
  options: { decisionUpdatedAt?: string } = {},
) {
  return [
    { key: "validation-contract", body: "objective/pass criteria" },
    { key: "worker-handoff", body: "completed/checks" },
    { key: "validator-report", body: "Verdict: PASS" },
    { key: "ceo-loop-decision", body: JSON.stringify(decision), updatedAt: options.decisionUpdatedAt },
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

  it("blocks CEO-safe next tasks when deterministic scan detects user-gated actions", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims this is safe to run autonomously.",
        nextTask: {
          title: "Deploy public campaign",
          description: "Deploy to production, merge into main, and post to Telegram after deleting stale accounts.",
          acceptanceCriteria: [
            "Purchase the required account credits before launch",
            "Rotate secret keys and change proxy settings for the campaign account",
          ],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks direct currency spend even when no budget noun is present", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims this payment is safe.",
        nextTask: {
          title: "Pay vendor amount",
          description: "Pay $500 to the vendor and store the receipt internally.",
          acceptanceCriteria: ["Receipt is linked back to the parent issue"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("does not treat ordinary lowercase 'of' near post as an external-platform gate", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue with an internal summary.",
        nextTask: {
          title: "Post summary of findings internally",
          description: "Post summary of findings to the internal Paperclip issue comment thread.",
          acceptanceCriteria: ["Internal Paperclip summary of findings is available for review"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "create_child",
      reason: "next_iteration",
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

  it("blocks older decisions whose iteration no longer matches the loop policy", () => {
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
      reason: "ceo_loop_decision_stale",
      reportToUser: false,
    });
  });

  it("blocks future decisions whose iteration is ahead of the loop policy", () => {
    const futureIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 1,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: futureIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 2,
        decision: "goal_reached",
        rationale: "This goal reached decision belongs to a future loop iteration.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_from_future",
      reportToUser: false,
    });
  });

  it("blocks same-iteration decisions that age past the loop freshness policy", () => {
    const freshnessBoundIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            maxDecisionAgeMinutes: 30,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: freshnessBoundIssue,
      documents: missionDocsWithDecision(
        {
          version: 1,
          iteration: 1,
          decision: "next_iteration",
          decisionWrittenAt: "2026-05-11T08:00:00.000Z",
          rationale: "This same-iteration next step is too old to trust.",
          nextTask: {
            title: "Create too-old child",
            acceptanceCriteria: ["should not be created from stale decision age"],
            safeToRunWithoutUserApproval: true,
          },
          evidence: ["validator-report PASS"],
        },
        { decisionUpdatedAt: "2026-05-11T08:00:00.000Z" },
      ),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_stale",
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
      reason: "ceo_loop_decision_stale",
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

  it("marks CEO self-attestation conflicts as user-visible blocked loop states", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the next step is safe.",
        nextTask: {
          title: "Release social campaign",
          description: "Publish to X and deploy to production without waiting for the board.",
          acceptanceCriteria: ["Protected branch merge is complete"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "blocked",
      supervisor: {
        attentionRequired: true,
        reason: "ceo_self_attestation_conflict",
        recoveryAction: "request_user_approval",
        owner: "user",
        userVisible: true,
      },
    });
    expect(state.supervisor).not.toHaveProperty("metricKey");
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
        reason: "ceo_loop_decision_stale",
        recoveryAction: "repair_loop_decision",
        owner: "operator",
        userVisible: false,
      },
    });
    expect(state.supervisor).not.toHaveProperty("metricKey");
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
