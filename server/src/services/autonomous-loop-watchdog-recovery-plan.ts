import type { Db } from "@paperclipai/db";
import {
  listAutonomousGoalLoopWatchdogPreview,
  type AutonomousGoalLoopWatchdogPreview,
  type AutonomousGoalLoopWatchdogPreviewCandidate,
} from "./autonomous-loop-watchdog-preview.js";

export const AUTONOMOUS_LOOP_RECOVERY_PLAN_BLOCKED_ACTIONS = [
  "request_user_approval",
  "create_approval",
  "create_child_issue",
  "upsert_issue_document",
  "continue_autonomous_goal_loop",
  "queue_wakeup",
] as const;

type AutonomousLoopRecoveryPlanBlockedAction = (typeof AUTONOMOUS_LOOP_RECOVERY_PLAN_BLOCKED_ACTIONS)[number];

export type AutonomousLoopRecoveryPlanMutationPolicy = {
  dryRunOnly: true;
  writesDocument: false;
  createsIssue: false;
  createsApproval: false;
  queuesWakeup: false;
  continuesAutonomousLoop: false;
  liveRecovery: false;
};

export type AutonomousLoopRecoveryPlanStep = {
  order: number;
  action:
    | "inspect_loop_state"
    | "inspect_mission_control_documents"
    | "draft_operator_repair"
    | "operator_applies_manually"
    | "review_loop_limits"
    | "review_goal_status"
    | "manual_operator_review";
  description: string;
  target?: {
    issueId: string;
    documentKey?: string;
  };
  wouldMutate: false;
};

export type AutonomousLoopRecoveryPlanItem = {
  id: string;
  candidateId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  severity: AutonomousGoalLoopWatchdogPreviewCandidate["severity"];
  reason: string;
  recoveryAction: string;
  planKind: "repair_loop_decision_document" | "review_loop_limits_or_close_goal" | "manual_operator_review";
  execution: "operator_manual_only";
  mutationPolicy: AutonomousLoopRecoveryPlanMutationPolicy;
  steps: AutonomousLoopRecoveryPlanStep[];
  blockedActions: readonly AutonomousLoopRecoveryPlanBlockedAction[];
};

export type AutonomousLoopRecoveryPlanSkippedCandidate = {
  candidateId: string;
  issueId: string;
  reason: "non_operator_owner" | "unsupported_recovery_action";
  owner: string | null;
  recoveryAction: string | null;
};

export type AutonomousLoopRecoveryPlanPreview = {
  companyId: string;
  mode: "recovery_plan_preview";
  dryRun: true;
  readOnly: true;
  liveRecovery: false;
  generatedAt: string;
  totalIssuesScanned: number;
  candidatesConsidered: number;
  plans: AutonomousLoopRecoveryPlanItem[];
  skippedCandidates: AutonomousLoopRecoveryPlanSkippedCandidate[];
  guardrails: {
    boardOnly: true;
    dryRunOnly: true;
    noLiveRecovery: true;
    noApprovalLaundering: true;
    allowedOwners: ["operator"];
  };
};

const MUTATION_POLICY: AutonomousLoopRecoveryPlanMutationPolicy = {
  dryRunOnly: true,
  writesDocument: false,
  createsIssue: false,
  createsApproval: false,
  queuesWakeup: false,
  continuesAutonomousLoop: false,
  liveRecovery: false,
};

function cloneMutationPolicy(): AutonomousLoopRecoveryPlanMutationPolicy {
  return { ...MUTATION_POLICY };
}

function basePlan(input: {
  candidate: AutonomousGoalLoopWatchdogPreviewCandidate;
  planKind: AutonomousLoopRecoveryPlanItem["planKind"];
  steps: AutonomousLoopRecoveryPlanStep[];
}): AutonomousLoopRecoveryPlanItem {
  const { candidate } = input;
  return {
    id: `recovery-plan:${candidate.issueId}:${candidate.recoveryAction}:${candidate.reason}`,
    candidateId: candidate.id,
    issueId: candidate.issueId,
    identifier: candidate.identifier,
    title: candidate.title,
    severity: candidate.severity,
    reason: candidate.reason,
    recoveryAction: candidate.recoveryAction,
    planKind: input.planKind,
    execution: "operator_manual_only",
    mutationPolicy: cloneMutationPolicy(),
    steps: input.steps,
    blockedActions: AUTONOMOUS_LOOP_RECOVERY_PLAN_BLOCKED_ACTIONS,
  };
}

function buildRepairLoopDecisionPlan(candidate: AutonomousGoalLoopWatchdogPreviewCandidate) {
  return basePlan({
    candidate,
    planKind: "repair_loop_decision_document",
    steps: [
      {
        order: 1,
        action: "inspect_loop_state",
        description: "Inspect the current autonomous-loop iteration, supervisor reason, and recovery metadata.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
      {
        order: 2,
        action: "inspect_mission_control_documents",
        description: "Read Mission Control documents and confirm the current ceo-loop-decision is stale, missing, or invalid.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
      {
        order: 3,
        action: "draft_operator_repair",
        description: "Draft a corrected ceo-loop-decision for an operator to review and apply manually.",
        target: { issueId: candidate.issueId, documentKey: "ceo-loop-decision" },
        wouldMutate: false,
      },
      {
        order: 4,
        action: "operator_applies_manually",
        description: "Operator applies the repair through the normal document flow only after human review.",
        target: { issueId: candidate.issueId, documentKey: "ceo-loop-decision" },
        wouldMutate: false,
      },
    ],
  });
}

function buildLoopLimitReviewPlan(candidate: AutonomousGoalLoopWatchdogPreviewCandidate) {
  return basePlan({
    candidate,
    planKind: "review_loop_limits_or_close_goal",
    steps: [
      {
        order: 1,
        action: "review_loop_limits",
        description: "Review loop runtime and iteration limits against the goal's current evidence.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
      {
        order: 2,
        action: "review_goal_status",
        description: "Decide manually whether the goal should be closed, refined, or receive new safe limits.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
      {
        order: 3,
        action: "operator_applies_manually",
        description: "Operator performs any limit or goal-status change explicitly outside this dry-run preview.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
    ],
  });
}

function buildManualReviewPlan(candidate: AutonomousGoalLoopWatchdogPreviewCandidate) {
  return basePlan({
    candidate,
    planKind: "manual_operator_review",
    steps: [
      {
        order: 1,
        action: "manual_operator_review",
        description: "Operator reviews the watchdog candidate, loop documents, and handoff evidence before choosing any manual repair.",
        target: { issueId: candidate.issueId },
        wouldMutate: false,
      },
    ],
  });
}

function planForCandidate(candidate: AutonomousGoalLoopWatchdogPreviewCandidate): AutonomousLoopRecoveryPlanItem | null {
  if (candidate.recoveryAction === "repair_loop_decision") return buildRepairLoopDecisionPlan(candidate);
  if (candidate.recoveryAction === "adjust_loop_limits_or_close_goal") return buildLoopLimitReviewPlan(candidate);
  if (candidate.recoveryAction === "manual_review") return buildManualReviewPlan(candidate);
  return null;
}

export function buildAutonomousGoalLoopWatchdogRecoveryPlanPreview(input: {
  preview: AutonomousGoalLoopWatchdogPreview;
  generatedAt?: string | Date;
}): AutonomousLoopRecoveryPlanPreview {
  const generatedAt = input.generatedAt instanceof Date
    ? input.generatedAt.toISOString()
    : input.generatedAt ?? new Date().toISOString();
  const plans: AutonomousLoopRecoveryPlanItem[] = [];
  const skippedCandidates: AutonomousLoopRecoveryPlanSkippedCandidate[] = [];

  for (const candidate of input.preview.candidates) {
    const owner = String((candidate as { owner?: string | null }).owner ?? "");
    const recoveryAction = String((candidate as { recoveryAction?: string | null }).recoveryAction ?? "");
    if (owner !== "operator") {
      skippedCandidates.push({
        candidateId: candidate.id,
        issueId: candidate.issueId,
        reason: "non_operator_owner",
        owner: owner || null,
        recoveryAction: recoveryAction || null,
      });
      continue;
    }

    const plan = planForCandidate(candidate);
    if (!plan) {
      skippedCandidates.push({
        candidateId: candidate.id,
        issueId: candidate.issueId,
        reason: "unsupported_recovery_action",
        owner,
        recoveryAction: recoveryAction || null,
      });
      continue;
    }
    plans.push(plan);
  }

  return {
    companyId: input.preview.companyId,
    mode: "recovery_plan_preview",
    dryRun: true,
    readOnly: true,
    liveRecovery: false,
    generatedAt,
    totalIssuesScanned: input.preview.totalIssuesScanned,
    candidatesConsidered: input.preview.candidates.length,
    plans,
    skippedCandidates,
    guardrails: {
      boardOnly: true,
      dryRunOnly: true,
      noLiveRecovery: true,
      noApprovalLaundering: true,
      allowedOwners: ["operator"],
    },
  };
}

export async function listAutonomousGoalLoopWatchdogRecoveryPlanPreview(
  db: Db,
  companyId: string,
  options: { limit?: number } = {},
): Promise<AutonomousLoopRecoveryPlanPreview> {
  const preview = await listAutonomousGoalLoopWatchdogPreview(db, companyId, options);
  return buildAutonomousGoalLoopWatchdogRecoveryPlanPreview({ preview });
}
