import {
  NATIVE_SPARK_EXECUTOR_AGENT_ID,
  type IssueAssignmentFenceAuthorization,
  type IssueAssignmentFenceReceipt,
  type IssueExecutionPolicy,
  type IssueExecutionState,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

export { NATIVE_SPARK_EXECUTOR_AGENT_ID } from "@paperclipai/shared";

export const ASSIGNMENT_FENCE_RECEIPT_TTL_MS = 5 * 60_000;
export const NATIVE_SPARK_HEALTH_MAX_AGE_MS = ASSIGNMENT_FENCE_RECEIPT_TTL_MS;

export type NativeSparkHealthSnapshot = {
  status?: string | null;
  errorReason?: string | null;
  lastHeartbeatAt?: Date | string | null;
};

/**
 * The persisted run binding is the receipt's source of truth. Agent health is
 * intentionally not used here: it is mutable status and can be stale, idle,
 * or changed by cancellation without proving that this issue actually ran.
 */
export type NativeSparkReceiptProvenance = {
  runId?: string | null;
  issueId?: string | null;
  agentId?: string | null;
  runtimeMode?: string | null;
  nativeIssueId?: string | null;
  driverKind?: string | null;
  nativePhase?: string | null;
  status?: string | null;
  finishedAt?: Date | string | null;
  nativePhaseUpdatedAt?: Date | string | null;
};

export function nativeSparkReceiptProvenanceBlockReason(
  run: NativeSparkReceiptProvenance | null | undefined,
  now = new Date(),
): string | null {
  if (!run) return "run_missing";
  if (run.status !== "succeeded") return "run_not_succeeded";
  if (run.runtimeMode !== "native") return "native_runtime_required";
  if (run.nativeIssueId == null || run.issueId == null || run.nativeIssueId !== run.issueId) {
    return "native_issue_binding_missing";
  }
  if (run.agentId !== NATIVE_SPARK_EXECUTOR_AGENT_ID) return "native_spark_agent_required";
  if (run.driverKind !== "codex") return "native_driver_required";
  if (run.nativePhase !== "completed") return "native_run_not_completed";
  if (!run.finishedAt || !run.nativePhaseUpdatedAt) return "run_completion_missing";

  const finishedAt = run.finishedAt instanceof Date ? run.finishedAt : new Date(run.finishedAt);
  const phaseUpdatedAt = run.nativePhaseUpdatedAt instanceof Date
    ? run.nativePhaseUpdatedAt
    : new Date(run.nativePhaseUpdatedAt);
  // Freshness is anchored to the durable run completion, not the mutable
  // phase/status heartbeat. A status mutation must not refresh a stale run.
  const completionAt = finishedAt.getTime();
  const phaseAgeMs = now.getTime() - phaseUpdatedAt.getTime();
  const ageMs = now.getTime() - completionAt;
  if (
    !Number.isFinite(completionAt)
    || !Number.isFinite(phaseAgeMs)
    || phaseAgeMs < 0
    || !Number.isFinite(ageMs)
    || ageMs < 0
    || ageMs > ASSIGNMENT_FENCE_RECEIPT_TTL_MS
  ) {
    return "run_stale";
  }
  return null;
}

export function nativeSparkInvokabilityBlockReason(
  snapshot: NativeSparkHealthSnapshot | null | undefined,
  now = new Date(),
): string | null {
  if (!snapshot) return "missing";
  if (snapshot.status !== "idle") return "status_not_idle";
  if (snapshot.errorReason?.trim()) return "error_present";
  if (!snapshot.lastHeartbeatAt) return "heartbeat_missing";

  const heartbeatAt = snapshot.lastHeartbeatAt instanceof Date
    ? snapshot.lastHeartbeatAt
    : new Date(snapshot.lastHeartbeatAt);
  const ageMs = now.getTime() - heartbeatAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > NATIVE_SPARK_HEALTH_MAX_AGE_MS) {
    return "heartbeat_stale";
  }
  return null;
}

export type IssueAssignmentFenceIntent = "explicit" | "checkout" | "automatic" | "unchanged" | "unknown";

type FencedIssue = {
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: IssueExecutionState | Record<string, unknown> | null;
};

type AssignmentFenceInput = {
  issue: FencedIssue;
  nextAssigneeAgentId: string | null;
  nextAssigneeUserId: string | null;
  nextStatus: string;
  assignmentIntent: IssueAssignmentFenceIntent;
  now?: Date;
};

function assignmentFenceFor(issue: FencedIssue) {
  return getIssueAssignmentFence(issue.executionPolicy);
}

export function getIssueAssignmentFence(policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined) {
  const candidate = policy && typeof policy === "object" ? (policy as Record<string, unknown>).assignmentFence : null;
  if (!candidate || typeof candidate !== "object") return null;
  const fence = candidate as Record<string, unknown>;
  if (fence.kind !== "native_spark_only" || fence.allowedAgentId !== NATIVE_SPARK_EXECUTOR_AGENT_ID) return null;
  return { kind: "native_spark_only" as const, allowedAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID };
}

function receiptIsFresh(
  receipt: unknown,
  now: Date,
): receipt is IssueAssignmentFenceReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const candidate = receipt as Record<string, unknown>;
  if (
    typeof candidate.runId !== "string"
    || !candidate.runId
    ||
    candidate.agentId !== NATIVE_SPARK_EXECUTOR_AGENT_ID
    || candidate.source !== "native"
    || typeof candidate.observedAt !== "string"
    || typeof candidate.expiresAt !== "string"
  ) return false;
  const observedAt = new Date(candidate.observedAt);
  const expiresAt = new Date(candidate.expiresAt);
  if (Number.isNaN(observedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return false;
  return observedAt.getTime() <= now.getTime() && now.getTime() <= expiresAt.getTime();
}

function reject(reason: string, input: AssignmentFenceInput): never {
  throw conflict(`Issue assignment fence blocked this mutation: ${reason}`, {
    code: "issue_assignment_fence",
    reason,
    issueStatus: input.issue.status,
    requestedAgentId: input.nextAssigneeAgentId,
    requestedUserId: input.nextAssigneeUserId,
    assignmentIntent: input.assignmentIntent,
  });
}

export function assertIssueAssignmentFence(input: AssignmentFenceInput): void {
  const fence = assignmentFenceFor(input.issue);
  if (!fence) return;

  if (input.issue.assigneeUserId && input.nextAssigneeUserId !== input.issue.assigneeUserId) {
    reject("user_assignment_rejected", input);
  }
  if (input.nextAssigneeUserId) reject("user_assignment_rejected", input);
  if (input.nextAssigneeAgentId !== null && input.nextAssigneeAgentId !== fence.allowedAgentId) {
    reject("non_native_agent_rejected", input);
  }

  if (input.nextAssigneeAgentId === null) {
    if (input.nextStatus !== "blocked") reject("issue_must_remain_blocked", input);
    return;
  }

  const state = input.issue.executionState && typeof input.issue.executionState === "object"
    ? input.issue.executionState as Record<string, unknown>
    : null;
  const authorization = state?.assignmentFenceAuthorization;
  const authorizationRecord = authorization && typeof authorization === "object"
    ? authorization as Record<string, unknown>
    : null;
  const now = input.now ?? new Date();
  if (
    input.assignmentIntent === "unchanged"
    && input.issue.assigneeAgentId === fence.allowedAgentId
    && input.issue.assigneeUserId === null
    && input.nextAssigneeAgentId === fence.allowedAgentId
    && input.nextAssigneeUserId === null
  ) {
    if (
      authorizationRecord?.agentId !== fence.allowedAgentId
      || authorizationRecord.source !== "explicit"
    ) reject("explicit_assignment_authorization_required", input);
    return;
  }
  if (!receiptIsFresh(state?.assignmentFenceReceipt, now)) reject("fresh_native_receipt_required", input);

  if (input.assignmentIntent === "explicit") return;
  if (input.assignmentIntent !== "checkout") reject("explicit_assignment_required", input);

  if (
    authorizationRecord?.agentId !== fence.allowedAgentId
    || authorizationRecord.source !== "explicit"
  ) reject("explicit_assignment_authorization_required", input);
  if (input.issue.assigneeAgentId !== fence.allowedAgentId) reject("checkout_cannot_establish_assignment", input);
}

export function applyIssueAssignmentFenceTransition(input: {
  issue: FencedIssue;
  currentExecutionState: IssueExecutionState | Record<string, unknown> | null | undefined;
  nextAssigneeAgentId: string | null;
  nextAssigneeUserId: string | null;
  assignmentIntent: IssueAssignmentFenceIntent;
  now?: Date;
}): IssueExecutionState | Record<string, unknown> | null | undefined {
  if (!assignmentFenceFor(input.issue)) return input.currentExecutionState;
  const current: Record<string, unknown> = input.currentExecutionState && typeof input.currentExecutionState === "object"
    ? { ...input.currentExecutionState }
    : {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
        changesRequestedCount: 0,
      };
  if (input.nextAssigneeAgentId === null && input.nextAssigneeUserId === null) {
    current.assignmentFenceAuthorization = null;
  } else if (
    input.assignmentIntent === "explicit"
    && input.nextAssigneeAgentId === NATIVE_SPARK_EXECUTOR_AGENT_ID
    && input.nextAssigneeUserId === null
  ) {
    const authorization: IssueAssignmentFenceAuthorization = {
      agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      assignedAt: (input.now ?? new Date()).toISOString(),
      source: "explicit",
    };
    current.assignmentFenceAuthorization = authorization;
  }
  return current;
}
