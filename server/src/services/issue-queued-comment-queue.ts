import { createHash } from "node:crypto";
import type { IssueComment, IssueQueuedCommentQueue } from "@paperclipai/shared";

const QUEUE_CONTEXT_KEY = "_paperclipWakeContext";
const QUEUE_IDS_KEY = "wakeCommentIds";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string" || !candidate || seen.has(candidate)) return [];
    seen.add(candidate);
    return [candidate];
  });
}

export function queuedCommentIdsFromWakePayload(payloadValue: unknown): string[] {
  const payload = record(payloadValue);
  const context = record(payload[QUEUE_CONTEXT_KEY]);
  return uniqueIds(context[QUEUE_IDS_KEY]);
}

export function queuedCommentIdsFromRunContext(contextValue: unknown): string[] {
  return uniqueIds(record(contextValue)[QUEUE_IDS_KEY]);
}

export function withQueuedCommentIdsInWakePayload(
  payloadValue: unknown,
  ids: string[],
): Record<string, unknown> {
  const payload = { ...record(payloadValue) };
  const context = { ...record(payload[QUEUE_CONTEXT_KEY]) };
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[QUEUE_IDS_KEY] = ids;
    context.wakeCommentId = latestId;
    context.commentId = latestId;
    payload.commentId = latestId;
  } else {
    delete context[QUEUE_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
    delete payload.commentId;
  }
  payload[QUEUE_CONTEXT_KEY] = context;
  return payload;
}

/**
 * Fingerprints one queued-comment queue: the wake id plus every comment's id
 * and last-updated time. A mutation that changes the queue changes this
 * value, so a caller can echo it back to detect a queue it no longer holds
 * the latest view of. The read path (`GET /queued-comments`) and every queue
 * mutation must call this same function, so a client's fingerprint always
 * compares against the same computation.
 */
export function queuedCommentQueueRevision(input: {
  queueId: string | null;
  comments: Array<{ id: string; updatedAt: Date }>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      queueId: input.queueId,
      comments: input.comments.map((comment) => [comment.id, comment.updatedAt.toISOString()]),
    }))
    .digest("hex")
    .slice(0, 32);
}

export function withQueuedCommentIdsInRunContext(
  contextValue: unknown,
  ids: string[],
): Record<string, unknown> {
  const context = { ...record(contextValue) };
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[QUEUE_IDS_KEY] = ids;
    context.wakeCommentId = latestId;
    context.commentId = latestId;
  } else {
    delete context[QUEUE_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
  }

  // These projections are generated immediately before dispatch. Any queue
  // mutation must force them to be rebuilt from the canonical comment ids.
  delete context.paperclipWake;
  delete context.paperclipWakeComment;
  delete context.paperclipTaskMarkdown;
  delete context.paperclipTaskMarkdownCompact;
  return context;
}

export type QueuedCommentQueueProtocol = "paperclip_runner_v1" | "legacy";

export type QueuedCommentQueueSteeringDecision =
  | { protocol: QueuedCommentQueueProtocol; kind: "unsupported" }
  | { protocol: QueuedCommentQueueProtocol; kind: "temporarily_unavailable" }
  /** Only the caller can probe the live runner. `steeringRunId` names the run to probe. */
  | { protocol: "paperclip_runner_v1"; kind: "probe"; steeringRunId: string };

/**
 * Decides the queue protocol and the steering answer for one queued-comment
 * queue, from plain facts. This is the one place that resolves the
 * `paperclip_runner_v1`/`legacy` protocol and the steering answer; every
 * caller that builds a queue response must call this function instead of
 * repeating the rule.
 *
 * When the decision is `"probe"`, only the caller can answer the question:
 * it must ask the live runner (through a call such as
 * `getNativeSessionSteeringState`) and fall back to
 * `"temporarily_unavailable"` on failure. A caller that never probes the
 * live runner must answer `"temporarily_unavailable"` for a `"probe"`
 * decision instead.
 */
export function decideQueuedCommentQueueSteering(facts: {
  state: "deferred" | "queued" | null;
  /** The queued run's own runtime mode. Read only when `state` is `"queued"`. */
  queueRunRuntimeMode: string | null;
  /** The currently running turn, if any. Read only when `state` is `"deferred"`. */
  activeRun: { id: string; runtimeMode: string | null } | null;
  assignedAgentAdapterType: string | null;
  queuedCommentCount: number;
}): QueuedCommentQueueSteeringDecision {
  const persistedRuntimeMode =
    facts.state === "queued"
      ? facts.queueRunRuntimeMode
      : facts.state === "deferred"
        ? facts.activeRun?.runtimeMode ?? null
        : null;

  const protocol: QueuedCommentQueueProtocol =
    persistedRuntimeMode === "native"
      || (persistedRuntimeMode === null && facts.assignedAgentAdapterType === "paperclip_runner")
      ? "paperclip_runner_v1"
      : "legacy";

  if (protocol !== "paperclip_runner_v1") {
    return { protocol, kind: "unsupported" };
  }

  const steeringRun = facts.state === "deferred" ? facts.activeRun : null;
  if (!steeringRun || facts.queuedCommentCount === 0) {
    return { protocol, kind: "temporarily_unavailable" };
  }

  return { protocol, kind: "probe", steeringRunId: steeringRun.id };
}

type QueuedCommentQueueEntryFacts = {
  id: string;
  updatedAt: Date;
  authorUserId: string | null;
};

/**
 * Assembles the shared `IssueQueuedCommentQueue` response from the already
 * resolved facts: the queue identity, the already-decided protocol and
 * steering answer, the live comment rows, and the actor who reads the
 * queue. This is the one place that builds the response shape; every
 * caller that builds a queue response must call this function instead of
 * repeating the rule.
 */
export function buildQueuedCommentQueueSnapshot<TComment extends QueuedCommentQueueEntryFacts>(facts: {
  issueId: string;
  queueId: string | null;
  state: "deferred" | "queued" | null;
  /** The currently running turn's id. Read only when `state` is `"deferred"`. */
  activeRunId: string | null;
  protocol: QueuedCommentQueueProtocol;
  steeringDisposition: IssueQueuedCommentQueue["steeringDisposition"];
  comments: TComment[];
  actorType: "agent" | "user";
  actorId: string;
}): IssueQueuedCommentQueue {
  return {
    issueId: facts.issueId,
    queueId: facts.queueId,
    state: facts.state,
    targetRunId: facts.state === "deferred" ? facts.activeRunId : null,
    revision: queuedCommentQueueRevision({ queueId: facts.queueId, comments: facts.comments }),
    protocol: facts.protocol,
    steeringDisposition: facts.steeringDisposition,
    entries: facts.comments.map((comment, position) => ({
      comment: comment as unknown as IssueComment,
      position,
      canEdit: facts.actorType === "user" && comment.authorUserId === facts.actorId,
      canDiscard: facts.actorType === "user" && comment.authorUserId === facts.actorId,
    })),
  };
}
