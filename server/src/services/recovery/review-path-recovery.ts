import { createHash } from "node:crypto";
import type { IssueReviewAttention } from "@paperclipai/shared";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";

export const ISSUE_REVIEW_PATH_LOST_WAKE_REASON = "issue_review_path_lost";
export const REVIEW_PATH_RECOVERY_INSTRUCTION =
  "This issue is still in review but its last maintained review path was consumed. Restore a reviewer, interaction, approval, monitor, or other durable waiting path, or choose an explicit disposition. This is the only automatic review-path recovery wake for this fingerprint.";
const REVIEW_PATH_RECOVERY_IDEMPOTENCY_INDEX = "agent_wakeup_requests_review_path_recovery_idempotency_uq";

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function reviewPathConsumedRefFromRun(input: {
  runId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
}) {
  const context = input.contextSnapshot ?? {};
  return readNonEmptyString(context.reviewPathConsumedRef)
    ?? readNonEmptyString(context.interactionId)
    ?? readNonEmptyString(context.approvalId)
    ?? (readNonEmptyString(context.wakeReason)?.startsWith("issue_monitor")
      ? `monitor:${input.issueId}:${readNonEmptyString(context.clearReason) ?? "cleared"}:${String(context.monitorAttemptCount ?? "unknown")}`
      : null)
    ?? input.runId;
}

export function buildIssueReviewPathLostIdempotencyKey(input: {
  issueId: string;
  consumedPathRef: string;
}) {
  const fingerprint = createHash("sha256").update(input.consumedPathRef).digest("hex").slice(0, 24);
  return `${ISSUE_REVIEW_PATH_LOST_WAKE_REASON}:${input.issueId}:${fingerprint}`;
}

export function isReviewPathRecoveryIdempotencyConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (
      candidate.code === "23505"
      && (
        constraint === REVIEW_PATH_RECOVERY_IDEMPOTENCY_INDEX
        || (typeof candidate.message === "string" && candidate.message.includes(REVIEW_PATH_RECOVERY_IDEMPOTENCY_INDEX))
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export type IssueReviewPathRecoveryDecision =
  | {
      kind: "enqueue";
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | { kind: "skip"; reason: string };

export function decideIssueReviewPathRecovery(input: {
  issueId: string;
  sourceRunId: string | null;
  assigneeAgentId: string | null;
  contextSnapshot: Record<string, unknown> | null | undefined;
  reviewAttention: IssueReviewAttention;
  existingWake: boolean;
}): IssueReviewPathRecoveryDecision {
  if (!input.assigneeAgentId) return { kind: "skip", reason: "review issue has no agent assignee" };
  if (input.reviewAttention.state !== "stalled") {
    return { kind: "skip", reason: "review issue still has a maintained path" };
  }

  const context = input.contextSnapshot ?? {};
  if (
    readNonEmptyString(context.wakeReason) === ISSUE_REVIEW_PATH_LOST_WAKE_REASON
    || context.reviewPathRecoveryAttempt === 1
  ) {
    return { kind: "skip", reason: "bounded review-path recovery already ran" };
  }

  const consumedPathRef = reviewPathConsumedRefFromRun({
    runId: input.sourceRunId ?? input.issueId,
    issueId: input.issueId,
    contextSnapshot: context,
  });
  const idempotencyKey = buildIssueReviewPathLostIdempotencyKey({
    issueId: input.issueId,
    consumedPathRef,
  });
  if (input.existingWake) return { kind: "skip", reason: "review-path recovery wake already exists" };

  const payload = withRecoveryModelProfileHint({
    issueId: input.issueId,
    taskId: input.issueId,
    sourceIssueId: input.issueId,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    reviewPathLost: true,
    reviewPathConsumedRef: consumedPathRef,
    reviewPathRecoveryAttempt: 1,
    maxReviewPathRecoveryAttempts: 1,
    instruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
  }, "normal_model");

  return {
    kind: "enqueue",
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryModelProfileHint({
      ...payload,
      wakeReason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      source: readNonEmptyString(context.source) ?? "heartbeat.review_path_disposition",
    }, "normal_model"),
  };
}
