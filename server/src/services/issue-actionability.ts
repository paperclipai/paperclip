import { hasCanonicalExecutionReviewState } from "./delivery-integrity.js";
import { buildIssueRoutingText } from "./issue-routing-heuristics.js";
import { qaCommentHasMergeBlockedMarker } from "./issue-qa-finalization.js";
import type { IssueTruthType } from "./operations-heartbeat-target.js";
import { isDeliveryScopedIssue } from "./qa-gate.js";

export function isIdleCanonicalDeliveryReview(input: {
  status: string;
  executionRunId?: string | null;
  executionRunStatus?: string | null;
  executionState?: unknown;
}) {
  const hasBlockingExecutionRun =
    input.executionRunId != null &&
    (
      input.executionRunStatus === undefined ||
      input.executionRunStatus === "queued" ||
      input.executionRunStatus === "running"
    );
  return hasCanonicalExecutionReviewState({
    status: input.status,
    executionState: input.executionState,
  }) && !hasBlockingExecutionRun;
}

export type OwnedIssueWakeActionability =
  | {
      kind: "ready";
      reason:
        | "live-run-limit retry reopened"
        | "canonical delivery review is idle with no linked execution run"
        | "owned issue is idle and has available capacity";
    }
  | {
      kind: "blocked";
      reason:
        | "missing assignee"
        | "no free slot"
        | "assignee unavailable"
        | "pending wakeup already exists"
        | "qa merge is blocked pending external resolution"
        | "structured truth is still suppressing idle refill"
        | "idle wake cooldown active";
    };

export function classifyOwnedIssueWakeActionability(input: {
  nowMs: number;
  hasFreeSlot: boolean;
  status: string;
  assigneeAgentId: string | null;
  assigneeRole?: string | null;
  assigneeStatus?: string | null;
  title?: string | null;
  description?: string | null;
  identifier?: string | null;
  projectName?: string | null;
  workIntent?: string | null;
  executionRunId?: string | null;
  executionRunStatus?: string | null;
  executionState?: unknown;
  latestStructuredTruthType: IssueTruthType;
  hasLatestStructuredTruthComment: boolean;
  latestStructuredTruthCreatedAtMs?: number | null;
  latestNonOperationsCommentBody?: string | null;
  latestWakeAgentId?: string | null;
  latestWakeStatus?: string | null;
  latestWakeReason?: string | null;
  latestOpsCommentHasIdleWakeMarker: boolean;
  latestOpsCommentCreatedAtMs?: number | null;
  latestAssigneeRunStatus?: string | null;
  latestAssigneeRunCreatedAtMs?: number | null;
  latestAssigneeRunFinishedAtMs?: number | null;
  idleWakeCooldownMs: number;
  recoveryRewakeCooldownMs: number;
  structuredTruthFreshnessWindowMs: number;
}): OwnedIssueWakeActionability {
  if (!input.assigneeAgentId) {
    return { kind: "blocked", reason: "missing assignee" };
  }
  if (!input.hasFreeSlot) {
    return { kind: "blocked", reason: "no free slot" };
  }
  if (
    input.assigneeStatus === "paused" ||
    input.assigneeStatus === "terminated" ||
    input.assigneeStatus === "pending_approval"
  ) {
    return { kind: "blocked", reason: "assignee unavailable" };
  }
  if (qaCommentHasMergeBlockedMarker(input.latestNonOperationsCommentBody)) {
    return { kind: "blocked", reason: "qa merge is blocked pending external resolution" };
  }

  const issueText = buildIssueRoutingText({
    identifier: input.identifier ?? null,
    title: input.title ?? "",
    description: input.description ?? null,
    projectName: input.projectName ?? null,
  });
  const idleCanonicalDeliveryReview = input.status === "in_review" && isDeliveryScopedIssue({
    workIntent: input.workIntent ?? null,
    assigneeRole: input.assigneeRole,
    issueText,
  }) && isIdleCanonicalDeliveryReview({
    status: input.status,
    executionRunId: input.executionRunId ?? null,
    executionRunStatus: input.executionRunStatus,
    executionState: input.executionState,
  });
  const hasFreshStructuredTruth = Boolean(
    input.hasLatestStructuredTruthComment &&
    input.latestStructuredTruthCreatedAtMs != null &&
    input.nowMs - input.latestStructuredTruthCreatedAtMs < input.structuredTruthFreshnessWindowMs,
  );
  const allowReviewRefillFromStructuredTruth =
    input.status === "in_review" &&
    isDeliveryScopedIssue({
      workIntent: input.workIntent ?? null,
      assigneeRole: input.assigneeRole,
      issueText,
    }) &&
    (
      input.latestStructuredTruthType === "handoff" ||
      input.latestStructuredTruthType === "completion"
    );
  if (hasFreshStructuredTruth && !allowReviewRefillFromStructuredTruth) {
    return { kind: "blocked", reason: "structured truth is still suppressing idle refill" };
  }

  const hasPendingWakeup =
    input.latestWakeAgentId === input.assigneeAgentId &&
    (
      input.latestWakeStatus === "queued" ||
      input.latestWakeStatus === "claimed" ||
      input.latestWakeStatus === "deferred_issue_execution"
    );
  if (hasPendingWakeup) {
    return { kind: "blocked", reason: "pending wakeup already exists" };
  }

  const latestWakeWasSkippedForLiveLimit =
    input.latestWakeAgentId === input.assigneeAgentId &&
    input.latestWakeStatus === "skipped" &&
    input.latestWakeReason === "heartbeat.live_run_limit_reached";
  if (latestWakeWasSkippedForLiveLimit) {
    return { kind: "ready", reason: "live-run-limit retry reopened" };
  }

  if (!input.latestOpsCommentHasIdleWakeMarker) {
    return {
      kind: "ready",
      reason: idleCanonicalDeliveryReview
        ? "canonical delivery review is idle with no linked execution run"
        : "owned issue is idle and has available capacity",
    };
  }

  const latestAssigneeRunTerminalAtMs =
    input.latestAssigneeRunFinishedAtMs
    ?? input.latestAssigneeRunCreatedAtMs
    ?? Number.NEGATIVE_INFINITY;
  const assigneeFailedSinceLastWake = Boolean(
    input.latestAssigneeRunStatus &&
    ["failed", "timed_out", "cancelled"].includes(input.latestAssigneeRunStatus) &&
    input.latestOpsCommentCreatedAtMs != null &&
    latestAssigneeRunTerminalAtMs >= input.latestOpsCommentCreatedAtMs,
  );
  const wakeCooldownMs = assigneeFailedSinceLastWake
    ? input.recoveryRewakeCooldownMs
    : input.idleWakeCooldownMs;
  if (
    input.latestOpsCommentCreatedAtMs != null &&
    input.nowMs - input.latestOpsCommentCreatedAtMs < wakeCooldownMs
  ) {
    return { kind: "blocked", reason: "idle wake cooldown active" };
  }

  return {
    kind: "ready",
    reason: idleCanonicalDeliveryReview
      ? "canonical delivery review is idle with no linked execution run"
      : "owned issue is idle and has available capacity",
  };
}
