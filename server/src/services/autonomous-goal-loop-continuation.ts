import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  evaluateMissionControlAutonomousLoopGate,
  evaluateMissionControlCompletionGate,
  MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
  type MissionControlAutonomousLoopReportEvent,
  type MissionControlCeoLoopDecision,
  type MissionControlCompletionGateDocument,
  type MissionControlCompletionGateResult,
  type MissionControlIssuePolicy,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { listMissionControlCompletionDocuments } from "./mission-control-gates.js";

export const AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND = "autonomous_goal_loop_iteration";
export const AUTONOMOUS_GOAL_LOOP_CONTINUATION_DOCUMENT_KEY = MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY;

const MAX_CONTINUATION_TITLE_LENGTH = 240;

type MissionControlCompletionGateReason = MissionControlCompletionGateResult["reason"];

type AutonomousGoalLoopContinuationReason =
  | MissionControlCompletionGateReason
  | "not_next_iteration"
  | "unsafe_next_task";

type AutonomousGoalLoopParentIssue = {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  identifier?: string | null;
  title: string;
  priority: string;
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number | null;
  executionPolicy?: unknown;
};

type AutonomousGoalLoopChildIssue = {
  id: string;
  parentId?: string | null;
  identifier?: string | null;
  title: string;
  status?: string | null;
  originKind?: string | null;
  originId?: string | null;
  originFingerprint?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type AutonomousGoalLoopActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type AutonomousGoalLoopChildInput = {
  title: string;
  description: string;
  status: "todo";
  workMode: "standard";
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  acceptanceCriteria: string[];
  blockParentUntilDone: boolean;
  originKind: string;
  originId: string;
  originFingerprint: string;
  executionPolicy: { missionControl: MissionControlIssuePolicy } | null;
};

export type AutonomousGoalLoopContinuationPlan =
  | {
      action: "ignore" | "wait" | "report" | "blocked";
      reason: AutonomousGoalLoopContinuationReason;
      reportToUser: boolean;
      gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
      ceoLoopDecision: MissionControlCeoLoopDecision | null;
    }
  | {
      action: "create_child";
      reason: "next_iteration";
      reportToUser: false;
      gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
      ceoLoopDecision: MissionControlCeoLoopDecision;
      originKind: string;
      originId: string;
      originFingerprint: string;
      childInput: AutonomousGoalLoopChildInput;
    };

export type AutonomousGoalLoopContinuationOutcome =
  | {
      outcome: "ignored" | "waiting" | "report_required" | "blocked";
      reason: AutonomousGoalLoopContinuationReason;
      reportToUser: boolean;
      plan: AutonomousGoalLoopContinuationPlan;
    }
  | {
      outcome: "already_exists" | "created";
      reason: "next_iteration";
      reportToUser: false;
      plan: Extract<AutonomousGoalLoopContinuationPlan, { action: "create_child" }>;
      childIssue: typeof issues.$inferSelect;
      parentBlockerAdded: boolean;
    };

export type AutonomousGoalLoopState =
  | {
      enabled: false;
      status: "disabled";
    }
  | {
      enabled: true;
      status:
        | "planning"
        | "executing"
        | "validating"
        | "ceo_review"
        | "goal_reached"
        | "blocked"
        | "approval_required"
        | "failed";
      goal: string | null;
      iteration: number;
      maxIterations: number | null;
      progressLabel: string;
      currentDecision: {
        iteration: number;
        decision: MissionControlCeoLoopDecision["decision"];
        decisionWrittenAt: string | null;
        rationale: string;
        nextTaskTitle: string | null;
        hardGate: MissionControlCeoLoopDecision["hardGate"];
        evidence: string[];
      } | null;
      planner: {
        mode: "single_child";
        supportsParallelChildren: false;
        nextTaskTitle: string | null;
        originFingerprint: string | null;
        childIssueId: string | null;
      };
      supervisor: {
        attentionRequired: boolean;
        reason: string | null;
        recoveryAction:
          | "none"
          | "request_user_approval"
          | "resolve_blocker"
          | "manual_recovery"
          | "repair_loop_decision"
          | "adjust_loop_limits_or_close_goal"
          | "manual_review";
        owner: "none" | "operator" | "user";
        metricKey: string | null;
        userVisible: boolean;
      };
      iterations: Array<{
        iteration: number;
        issueId: string;
        identifier: string | null;
        title: string;
        status: string | null;
        originFingerprint: string | null;
        parentId: string | null;
        createdAt: string | null;
        updatedAt: string | null;
      }>;
      observability: {
        generatedAt: string;
        chain: Array<
          | {
              kind: "goal";
              issueId: string;
              identifier: string | null;
              title: string;
              status: string | null;
            }
          | {
              kind: "iteration";
              issueId: string;
              identifier: string | null;
              title: string;
              status: string | null;
              iteration: number;
            }
        >;
      };
    };

function truncateTitle(value: string) {
  if (value.length <= MAX_CONTINUATION_TITLE_LENGTH) return value;
  return value.slice(0, MAX_CONTINUATION_TITLE_LENGTH - 1).trimEnd();
}

function continuationOriginFingerprint(decision: MissionControlCeoLoopDecision) {
  return `iteration:${decision.iteration}`;
}

function serializeDate(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function iterationFromOriginFingerprint(value: string | null | undefined) {
  const match = value?.match(/^iteration:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed + 1 : null;
}

function readStatus(value: string | null | undefined) {
  return value ?? null;
}

function progressLabelFor(iteration: number, maxIterations: number | null) {
  return maxIterations ? `${iteration} / ${maxIterations}` : `${iteration}`;
}

function isDecisionRepairReason(reason: string) {
  return reason === "invalid_ceo_loop_decision" ||
    reason === "ceo_loop_iteration_mismatch" ||
    reason === "ceo_loop_decision_stale" ||
    reason === "ceo_loop_decision_from_future";
}

function safetyMetricKeyForReason(reason: string) {
  if (reason === "ceo_loop_decision_stale" || reason === "ceo_loop_decision_from_future") {
    return "autonomous_loop_decision_freshness_failure";
  }
  if (reason === "ceo_loop_iteration_mismatch") return "autonomous_loop_decision_iteration_mismatch";
  if (reason === "invalid_ceo_loop_decision") return "autonomous_loop_decision_repair_required";
  return null;
}

function supervisorFor(input: {
  reason: string;
  decision: MissionControlCeoLoopDecision | null;
}): Extract<AutonomousGoalLoopState, { enabled: true }>["supervisor"] {
  if (isDecisionRepairReason(input.reason)) {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "repair_loop_decision",
      owner: "operator",
      metricKey: safetyMetricKeyForReason(input.reason),
      userVisible: false,
    };
  }
  if (input.reason === "approval_required" || input.decision?.decision === "approval_required") {
    return {
      attentionRequired: true,
      reason: "approval_required",
      recoveryAction: "request_user_approval",
      owner: "user",
      metricKey: null,
      userVisible: true,
    };
  }
  if (input.reason === "runtime_exceeded" || input.reason === "iteration_exceeded") {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "adjust_loop_limits_or_close_goal",
      owner: "operator",
      metricKey: "autonomous_loop_limit_attention",
      userVisible: true,
    };
  }
  if (input.reason === "missing_ceo_loop_decision" || input.reason === "missing_documents") {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "manual_review",
      owner: "operator",
      metricKey: "autonomous_loop_manual_review_required",
      userVisible: false,
    };
  }
  if (input.decision?.decision === "blocked") {
    return {
      attentionRequired: true,
      reason: "blocked",
      recoveryAction: "resolve_blocker",
      owner: "user",
      metricKey: null,
      userVisible: true,
    };
  }
  if (input.decision?.decision === "failed") {
    return {
      attentionRequired: true,
      reason: "failed",
      recoveryAction: "manual_recovery",
      owner: "user",
      metricKey: null,
      userVisible: true,
    };
  }
  return {
    attentionRequired: false,
    reason: null,
    recoveryAction: "none",
    owner: "none",
    metricKey: null,
    userVisible: false,
  };
}

function statusFor(input: {
  reason: string;
  decision: MissionControlCeoLoopDecision | null;
  matchingChildIssue: AutonomousGoalLoopChildIssue | null;
}): Extract<AutonomousGoalLoopState, { enabled: true }>["status"] {
  if (isDecisionRepairReason(input.reason)) return "failed";
  if (input.reason === "approval_required" || input.decision?.decision === "approval_required") return "approval_required";
  if (input.decision?.decision === "goal_reached") return "goal_reached";
  if (input.decision?.decision === "blocked") return "blocked";
  if (input.decision?.decision === "failed") return "failed";
  if (input.reason === "runtime_exceeded" || input.reason === "iteration_exceeded") return "blocked";
  if (input.decision?.decision === "next_iteration") return input.matchingChildIssue ? "executing" : "planning";
  if (input.reason === "validator_pass_required" || input.reason === "validator_not_passed") return "validating";
  return "ceo_review";
}

export function buildAutonomousGoalLoopState(input: {
  issue: AutonomousGoalLoopParentIssue;
  documents: MissionControlCompletionGateDocument[];
  childIssues?: AutonomousGoalLoopChildIssue[];
  now?: string | Date;
}): AutonomousGoalLoopState {
  const gate = evaluateMissionControlAutonomousLoopGate({
    issue: input.issue,
    documents: input.documents,
    now: input.now,
  });

  if (!gate.enabled || !gate.autonomousLoopPolicy?.enabled) {
    return { enabled: false, status: "disabled" };
  }

  const decision = gate.ceoLoopDecision;
  const originFingerprint = decision?.decision === "next_iteration" ? continuationOriginFingerprint(decision) : null;
  const matchingChildIssue =
    originFingerprint && decision
      ? input.childIssues?.find(
          (child) =>
            child.originKind === AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND &&
            child.originId === input.issue.id &&
            child.originFingerprint === originFingerprint,
        ) ?? null
      : null;

  const loopPolicy = gate.autonomousLoopPolicy;
  const iteration = loopPolicy.iteration;
  const maxIterations = loopPolicy.maxIterations ?? null;
  const supervisor = supervisorFor({ reason: gate.reason, decision });
  const status = statusFor({ reason: gate.reason, decision, matchingChildIssue });
  const generatedAt = input.now instanceof Date ? input.now.toISOString() : (input.now ?? new Date().toISOString());

  const iterations = (input.childIssues ?? [])
    .filter((child) => child.originKind === AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND && child.originId === input.issue.id)
    .map((child) => ({
      iteration: iterationFromOriginFingerprint(child.originFingerprint) ?? iteration + 1,
      issueId: child.id,
      identifier: child.identifier ?? null,
      title: child.title,
      status: readStatus(child.status),
      originFingerprint: child.originFingerprint ?? null,
      parentId: child.parentId ?? null,
      createdAt: serializeDate(child.createdAt),
      updatedAt: serializeDate(child.updatedAt),
    }))
    .sort((left, right) => left.iteration - right.iteration || left.title.localeCompare(right.title));

  return {
    enabled: true,
    status,
    goal: loopPolicy.goal ?? input.issue.title ?? null,
    iteration,
    maxIterations,
    progressLabel: progressLabelFor(iteration, maxIterations),
    currentDecision: decision
      ? {
          iteration: decision.iteration,
          decision: decision.decision,
          decisionWrittenAt: decision.decisionWrittenAt ?? null,
          rationale: decision.rationale,
          nextTaskTitle: decision.nextTask?.title ?? null,
          hardGate: decision.hardGate,
          evidence: decision.evidence,
        }
      : null,
    planner: {
      mode: "single_child",
      supportsParallelChildren: false,
      nextTaskTitle: decision?.nextTask?.title ?? null,
      originFingerprint,
      childIssueId: matchingChildIssue?.id ?? null,
    },
    supervisor,
    iterations,
    observability: {
      generatedAt,
      chain: [
        {
          kind: "goal",
          issueId: input.issue.id,
          identifier: input.issue.identifier ?? null,
          title: input.issue.title,
          status: readStatus(input.issue.status),
        },
        ...iterations.map((child) => ({
          kind: "iteration" as const,
          issueId: child.issueId,
          identifier: child.identifier,
          title: child.title,
          status: child.status,
          iteration: child.iteration,
        })),
      ],
    },
  };
}

function childMissionControlPolicy(parentPolicy: MissionControlIssuePolicy): MissionControlIssuePolicy {
  return {
    ...parentPolicy,
    autonomousLoop: null,
  };
}

function childDescription(input: {
  issue: AutonomousGoalLoopParentIssue;
  decision: MissionControlCeoLoopDecision;
  goal: string | null | undefined;
}) {
  const nextTask = input.decision.nextTask!;
  const parentLabel = input.issue.identifier ? `${input.issue.identifier} — ${input.issue.title}` : input.issue.title;
  const sections = [
    "## Autonomous Loop Continuation",
    "",
    `Parent: ${parentLabel}`,
    `Loop iteration: ${input.decision.iteration + 1}`,
    input.goal ? `Goal: ${input.goal}` : null,
    "Safety: safe internal autonomous-loop continuation only; live, destructive, spend, account/proxy, production deploy, or protected-branch actions still require explicit user approval.",
    "",
    "## CEO Rationale",
    "",
    input.decision.rationale,
    "",
    "## Next Task",
    "",
    nextTask.description?.trim() || nextTask.title,
    nextTask.assigneeHint ? "" : null,
    nextTask.assigneeHint ? `Assignee hint: ${nextTask.assigneeHint}` : null,
  ].filter((value): value is string => typeof value === "string");

  return sections.join("\n");
}

function reportEventFor(input: {
  reason: AutonomousGoalLoopContinuationReason;
  decision: MissionControlCeoLoopDecision | null;
}): MissionControlAutonomousLoopReportEvent | null {
  if (input.reason === "approval_required") return "approval_required";
  if (input.reason === "runtime_exceeded") return "runtime_exceeded";
  if (input.reason === "iteration_exceeded") return "iteration_exceeded";
  if (input.decision?.decision === "goal_reached") return "goal_reached";
  if (input.decision?.decision === "blocked") return "blocker";
  if (input.decision?.decision === "failed") return "failed";
  return null;
}

function shouldReportToUser(input: {
  policy: MissionControlIssuePolicy | null;
  reason: AutonomousGoalLoopContinuationReason;
  decision: MissionControlCeoLoopDecision | null;
}) {
  const event = reportEventFor({ reason: input.reason, decision: input.decision });
  if (!event) return false;
  return input.policy?.autonomousLoop?.reportToUserOnlyOn.includes(event) ?? false;
}

function nonCreatePlan(input: {
  action: "ignore" | "wait" | "report" | "blocked";
  reason: AutonomousGoalLoopContinuationReason;
  gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
  ceoLoopDecision: MissionControlCeoLoopDecision | null;
  reportToUser?: boolean;
}): AutonomousGoalLoopContinuationPlan {
  return {
    action: input.action,
    reason: input.reason,
    reportToUser: input.reportToUser ?? shouldReportToUser({
      policy: input.gate.policy,
      reason: input.reason,
      decision: input.ceoLoopDecision,
    }),
    gate: input.gate,
    ceoLoopDecision: input.ceoLoopDecision,
  };
}

export function buildAutonomousGoalLoopContinuationPlan(input: {
  issue: AutonomousGoalLoopParentIssue;
  documents: MissionControlCompletionGateDocument[];
  now?: string | Date;
}): AutonomousGoalLoopContinuationPlan {
  const gate = evaluateMissionControlCompletionGate({
    issue: input.issue,
    documents: input.documents,
    now: input.now,
  });

  if (!gate.enabled || !gate.policy?.autonomousLoop?.enabled) {
    return nonCreatePlan({
      action: "ignore",
      reason: gate.reason,
      gate,
      ceoLoopDecision: gate.ceoLoopDecision,
      reportToUser: false,
    });
  }

  const decision = gate.ceoLoopDecision;
  if (!decision) {
    return nonCreatePlan({
      action: gate.reason === "missing_documents" || gate.reason === "validator_not_passed" ? "wait" : "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: null,
      reportToUser: false,
    });
  }

  if (isDecisionRepairReason(gate.reason)) {
    return nonCreatePlan({
      action: "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: decision,
      reportToUser: false,
    });
  }

  if (decision.decision !== "next_iteration") {
    return nonCreatePlan({
      action: decision.decision === "goal_reached" ? "report" : "blocked",
      reason: gate.reason === "allowed" ? "not_next_iteration" : gate.reason,
      gate,
      ceoLoopDecision: decision,
    });
  }

  if (gate.reason !== "autonomous_loop_not_complete") {
    return nonCreatePlan({
      action: "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: decision,
    });
  }

  if (!decision.nextTask?.safeToRunWithoutUserApproval) {
    return nonCreatePlan({
      action: "blocked",
      reason: "unsafe_next_task",
      gate,
      ceoLoopDecision: decision,
      reportToUser: true,
    });
  }

  const originFingerprint = continuationOriginFingerprint(decision);
  const loopNumber = decision.iteration + 1;
  return {
    action: "create_child",
    reason: "next_iteration",
    reportToUser: false,
    gate,
    ceoLoopDecision: decision,
    originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
    originId: input.issue.id,
    originFingerprint,
    childInput: {
      title: truncateTitle(`[Loop ${loopNumber}] ${decision.nextTask.title}`),
      description: childDescription({
        issue: input.issue,
        decision,
        goal: gate.policy.autonomousLoop.goal,
      }),
      status: "todo",
      workMode: "standard",
      priority: input.issue.priority,
      assigneeAgentId: input.issue.assigneeAgentId ?? null,
      assigneeUserId: null,
      acceptanceCriteria: decision.nextTask.acceptanceCriteria,
      blockParentUntilDone: true,
      originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
      originId: input.issue.id,
      originFingerprint,
      executionPolicy: {
        missionControl: childMissionControlPolicy(gate.policy),
      },
    },
  };
}

async function findExistingContinuationChild(
  db: Db,
  input: { companyId: string; parentIssueId: string; originFingerprint: string },
) {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.parentId, input.parentIssueId),
        eq(issues.originKind, AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND),
        eq(issues.originId, input.parentIssueId),
        eq(issues.originFingerprint, input.originFingerprint),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

export async function continueAutonomousGoalLoopFromDecision(input: {
  db: Db;
  issue: AutonomousGoalLoopParentIssue;
  actor: AutonomousGoalLoopActor;
  documents?: MissionControlCompletionGateDocument[];
  now?: string | Date;
}): Promise<AutonomousGoalLoopContinuationOutcome> {
  const documents = input.documents ?? await listMissionControlCompletionDocuments(input.db, input.issue.id);
  const plan = buildAutonomousGoalLoopContinuationPlan({
    issue: input.issue,
    documents,
    now: input.now,
  });

  if (plan.action !== "create_child") {
    const outcome =
      plan.action === "ignore" ? "ignored" : plan.action === "wait" ? "waiting" : plan.action === "report" ? "report_required" : "blocked";
    return {
      outcome,
      reason: plan.reason,
      reportToUser: plan.reportToUser,
      plan,
    };
  }

  const existing = await findExistingContinuationChild(input.db, {
    companyId: input.issue.companyId,
    parentIssueId: input.issue.id,
    originFingerprint: plan.originFingerprint,
  });
  if (existing) {
    return {
      outcome: "already_exists",
      reason: "next_iteration",
      reportToUser: false,
      plan,
      childIssue: existing,
      parentBlockerAdded: false,
    };
  }

  const created = await issueService(input.db).createChild(input.issue.id, {
    ...plan.childInput,
    createdByAgentId: input.actor.agentId ?? null,
    createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    actorAgentId: input.actor.agentId ?? null,
    actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    originRunId: input.actor.runId ?? null,
  });

  return {
    outcome: "created",
    reason: "next_iteration",
    reportToUser: false,
    plan,
    childIssue: created.issue,
    parentBlockerAdded: created.parentBlockerAdded,
  };
}

export function summarizeAutonomousGoalLoopContinuationOutcome(outcome: AutonomousGoalLoopContinuationOutcome) {
  if (outcome.outcome === "created" || outcome.outcome === "already_exists") {
    return {
      outcome: outcome.outcome,
      reason: outcome.reason,
      reportToUser: outcome.reportToUser,
      parentIssueId: outcome.plan.originId,
      childIssueId: outcome.childIssue.id,
      childIdentifier: outcome.childIssue.identifier ?? null,
      childTitle: outcome.childIssue.title,
      originFingerprint: outcome.plan.originFingerprint,
      parentBlockerAdded: outcome.parentBlockerAdded,
    };
  }

  return {
    outcome: outcome.outcome,
    reason: outcome.reason,
    reportToUser: outcome.reportToUser,
    ceoLoopDecision: outcome.plan.ceoLoopDecision
      ? {
          iteration: outcome.plan.ceoLoopDecision.iteration,
          decision: outcome.plan.ceoLoopDecision.decision,
          hardGate: outcome.plan.ceoLoopDecision.hardGate ?? null,
        }
      : null,
  };
}
