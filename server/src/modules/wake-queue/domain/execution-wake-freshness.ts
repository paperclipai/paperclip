// Pure rule: does a deferred wake that carries an execution stage still
// match its issue? The release drain applies it to every candidate while it
// holds the issue row lock; the stranded-queue scan applies it as a
// pre-filter. Both pass plain data in.
//
// A wake is judged by what it carries, not by its current wake reason: a
// later wake merged into a deferred one replaces the reason but keeps the
// saved stage.
//
// System continuations (`run_liveness_continuation`,
// `issue_continuation_needed`) are not judged here and not revisited by the
// scan: they come from recovery paths with their own conditions. A merged
// wake that carries a run liveness continuation keeps it as work of its own
// (see `carriesRunLivenessContinuation`), as an unmerged one would.
import {
  carriesRunLivenessContinuation,
  deferredWakePreservesIndependentContinuation,
  hasInteractionContinuationWakeContext,
  isCommentOnlyWakeReason,
  RUN_LIVENESS_CONTINUATION_WAKE_REASON,
} from "./context.js";
import { parseObject, readNonEmptyString } from "./values.js";

export const EXECUTION_STAGE_WAKE_REASONS = [
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
] as const;

export const STALE_EXECUTION_WAKE_REASON =
  "The stage or assignment this deferred wake was for has moved on";

// The reason each stage wake role is created with, as the issue route sets it.
const STAGE_WAKE_REASON_BY_ROLE: Record<string, string> = {
  reviewer: "execution_review_requested",
  approver: "execution_approval_requested",
  executor: "execution_changes_requested",
};

const STAGE_WAKE_SOURCE = "issue.execution_stage";
const COMMENT_WAKE_SOURCE = "issue.comment";

export type ExecutionWakeFreshnessFacts = {
  wake: {
    agentId: string;
    payload: Record<string, unknown> | null;
    authorizedFailedChatRetry?: boolean;
  };
  issue: { status: string; assigneeAgentId: string | null; executionState: unknown };
};

/**
 * - `not_applicable`: the wake carries no saved execution stage;
 * - `current`: its saved stage still matches the issue;
 * - `stale`: its saved stage no longer matches and nothing else is left, so it
 *   must not be promoted;
 * - `stale_part`: its saved stage no longer matches, but the wake also carries
 *   other work (queued comments, an interaction or its continuation, a resume
 *   intent, an authorized failed-chat retry, a run liveness continuation, or
 *   another wake reason). That work must still be delivered, without the
 *   stale stage (see `withoutStaleExecutionContext`).
 */
export type ExecutionWakeFreshness = "not_applicable" | "current" | "stale" | "stale_part";

function isStageReason(reason: string | null) {
  return reason !== null && (EXECUTION_STAGE_WAKE_REASONS as readonly string[]).includes(reason);
}

function savedStage(payload: Record<string, unknown>, seed: Record<string, unknown>) {
  const stage = parseObject(payload.executionStage ?? seed.executionStage);
  return readNonEmptyString(stage.stageId) ? stage : null;
}

function stageIsCurrent(stage: Record<string, unknown>, reason: string | null, wake: ExecutionWakeFreshnessFacts["wake"],
  issue: ExecutionWakeFreshnessFacts["issue"]) {
  if (issue.assigneeAgentId !== wake.agentId || issue.status === "done" || issue.status === "cancelled") return false;
  const state = parseObject(issue.executionState);
  if (state.currentStageId !== stage.stageId) return false;
  const role = readNonEmptyString(stage.wakeRole);
  const matches = (status: string, principal: unknown) => {
    const target = parseObject(principal);
    return state.status === status && target.type === "agent" && target.agentId === wake.agentId;
  };
  const asExecutor = matches("changes_requested", state.returnAssignee);
  const asParticipant = matches("pending", state.currentParticipant);
  if (role === "executor" || reason === "execution_changes_requested") return asExecutor;
  if (role === "reviewer" || role === "approver" || isStageReason(reason)) return asParticipant;
  return asExecutor || asParticipant;
}

/** The saved stage and whether it is current (`null` when there is none). */
function judgeStage(facts: ExecutionWakeFreshnessFacts) {
  const payload = parseObject(facts.wake.payload);
  const seed = parseObject(payload._paperclipWakeContext);
  const stage = savedStage(payload, seed);
  return {
    payload,
    seed,
    stage,
    current: stage ? stageIsCurrent(stage, readNonEmptyString(seed.wakeReason), facts.wake, facts.issue) : null,
  };
}

function carriesOtherWork(payload: Record<string, unknown>, seed: Record<string, unknown>, authorizedFailedChatRetry?: boolean) {
  const queuedCommentIds = Array.isArray(seed.wakeCommentIds) ? seed.wakeCommentIds : [];
  const reason = readNonEmptyString(seed.wakeReason);
  // A comment reason is not work by itself: with no queued comments left it
  // only names comments that are gone.
  return queuedCommentIds.length > 0 || payload.mutation === "interaction" || seed.resumeIntent === true ||
    hasInteractionContinuationWakeContext(seed) || authorizedFailedChatRetry === true ||
    carriesRunLivenessContinuation(seed) || (!isCommentOnlyWakeReason(reason) && !isStageReason(reason));
}

export function decideExecutionWakeFreshness(facts: ExecutionWakeFreshnessFacts): ExecutionWakeFreshness {
  const { payload, seed, current } = judgeStage(facts);
  if (current === null) return "not_applicable";
  if (current) return "current";
  return carriesOtherWork(payload, seed, facts.wake.authorizedFailedChatRetry) ? "stale_part" : "stale";
}

/**
 * Whether the wake carries a saved execution stage that still matches the
 * issue. That stage is work of its own: a queued comment that was deleted, or
 * already delivered, must not take it down with it, whatever reason the
 * merged wake row now shows.
 */
export function carriesCurrentExecutionStage(facts: ExecutionWakeFreshnessFacts) {
  return judgeStage(facts).current === true;
}

/**
 * When a comment was merged into a stage wake or a run liveness continuation
 * and every queued comment is now gone, the wake still shows the comment
 * reason. Gives it back the reason of the work it still carries: the reason of
 * a current saved stage, else `run_liveness_continuation` for a carried
 * continuation (not judged, as an unmerged one would not be). The promoted
 * run is then not told it was woken by a comment it will not see, and a wake
 * left deferred is stored under a reason the stranded-queue scan selects. A
 * wake that still has queued comments, or a reason other than a comment
 * reason, is returned unchanged.
 */
export function withExecutionWakeReasonRestored<T extends {
  agentId: string;
  payload: Record<string, unknown>;
  deferredContextSeed: Record<string, unknown>;
  wakeReason: string | null;
}>(wake: T, issue: ExecutionWakeFreshnessFacts["issue"]): T {
  const queuedCommentIds = Array.isArray(wake.deferredContextSeed.wakeCommentIds) ? wake.deferredContextSeed.wakeCommentIds : [];
  if (queuedCommentIds.length > 0 || !isCommentOnlyWakeReason(readNonEmptyString(wake.deferredContextSeed.wakeReason))) {
    return wake;
  }
  const judged = judgeStage({ wake: { agentId: wake.agentId, payload: wake.payload }, issue });
  const stage = judged.current === true ? judged.stage : null;
  const reason = stage
    ? STAGE_WAKE_REASON_BY_ROLE[readNonEmptyString(stage.wakeRole) ?? ""] ?? null
    : carriesRunLivenessContinuation(wake.deferredContextSeed) ? RUN_LIVENESS_CONTINUATION_WAKE_REASON : null;
  if (!reason) return wake;
  const seed: Record<string, unknown> = { ...wake.deferredContextSeed, wakeReason: reason };
  if (seed.source === COMMENT_WAKE_SOURCE) {
    if (stage) seed.source = STAGE_WAKE_SOURCE;
    else delete seed.source;
  }
  const nextPayload: Record<string, unknown> = { ...wake.payload };
  if (nextPayload._paperclipWakeContext !== undefined) nextPayload._paperclipWakeContext = seed;
  return { ...wake, payload: nextPayload, deferredContextSeed: seed, wakeReason: reason };
}

/**
 * Removes a stale saved stage from a wake that also carries other work, so a
 * promoted run gets that work without the old instructions: the wake loses
 * `executionStage`, its stage reason and the `issue.execution_stage` source.
 * A removed reason becomes `issue_commented` when queued comments remain,
 * else `run_liveness_continuation` for a carried continuation; otherwise it
 * is dropped (and promotion's fallback to the wake row's reason names the
 * remaining work).
 */
export function withoutStaleExecutionContext<T extends {
  agentId: string;
  payload: Record<string, unknown>;
  deferredContextSeed: Record<string, unknown>;
  wakeReason: string | null;
}>(wake: T, issue: ExecutionWakeFreshnessFacts["issue"]): T {
  if (judgeStage({ wake: { agentId: wake.agentId, payload: wake.payload }, issue }).current !== false) return wake;
  const seed: Record<string, unknown> = { ...wake.deferredContextSeed };
  const payload: Record<string, unknown> = { ...wake.payload };
  delete seed.executionStage;
  delete payload.executionStage;
  if (isStageReason(readNonEmptyString(seed.wakeReason))) delete seed.wakeReason;
  if (seed.source === STAGE_WAKE_SOURCE) delete seed.source;
  if (!readNonEmptyString(seed.wakeReason)) {
    if (Array.isArray(seed.wakeCommentIds) && seed.wakeCommentIds.length > 0) seed.wakeReason = "issue_commented";
    else if (carriesRunLivenessContinuation(seed)) seed.wakeReason = RUN_LIVENESS_CONTINUATION_WAKE_REASON;
  }
  if (payload._paperclipWakeContext !== undefined) payload._paperclipWakeContext = seed;
  return { ...wake, payload, deferredContextSeed: seed, wakeReason: readNonEmptyString(seed.wakeReason) };
}

type StoredWake = { agentId: string; payload: unknown };

function asDrainWake(wake: StoredWake) {
  const payload = parseObject(wake.payload);
  const deferredContextSeed = parseObject(payload._paperclipWakeContext);
  return { agentId: wake.agentId, payload, deferredContextSeed, wakeReason: readNonEmptyString(deferredContextSeed.wakeReason) };
}

/** The stored payload with a stale saved stage removed and the reason of the work it still carries. */
function storedPayloadWithoutStaleStage(wake: StoredWake, issue: ExecutionWakeFreshnessFacts["issue"]) {
  return withExecutionWakeReasonRestored(withoutStaleExecutionContext(asDrainWake(wake), issue), issue).payload;
}

/**
 * What the stranded-queue scan does with a selected wake, judged against the
 * issue row it read with it (outside the issue lock, so the caller writes only
 * if neither row changed since):
 * - `cancel`: only a stale stage is left;
 * - `store`: a stale stage shares the wake with work this scan does not
 *   promote itself (a carried run liveness continuation, for one), so
 *   skipping it would keep it at the head of every later pass. It is stored
 *   without the stale stage, under the reason of what it still carries; it
 *   then leaves the stage selection and that work waits as it would unmerged;
 * - `none`: the scan goes on as before (current stage, or other work the scan
 *   promotes, such as queued comments, an interaction response or a resolved
 *   dependency; the release drain removes a stale stage from it under the
 *   issue lock).
 */
export function decideParkedStageScan(
  facts: { wake: StoredWake; issue: ExecutionWakeFreshnessFacts["issue"] },
  scanPromotesOtherWork: boolean,
): { kind: "cancel" } | { kind: "store"; payload: Record<string, unknown> } | { kind: "none" } {
  const freshness = decideExecutionWakeFreshness({ wake: { agentId: facts.wake.agentId, payload: parseObject(facts.wake.payload) }, issue: facts.issue });
  if (freshness === "stale") return { kind: "cancel" };
  if (freshness === "stale_part" && !scanPromotesOtherWork) {
    return { kind: "store", payload: storedPayloadWithoutStaleStage(facts.wake, facts.issue) };
  }
  return { kind: "none" };
}

/**
 * Settles a saved wake after the pause-lifted pass dropped the comments a
 * completed run already received (`wake.payload` already lists only the
 * remaining ones). It applies the release drain's rules, so delivered
 * comments take down only themselves:
 * - `cancel_delivered`: no comments are left and nothing else (as before);
 * - `cancel_stale`: only a stale stage is left;
 * - `store`: keep the wake with this payload. A current stage, a carried run
 *   liveness continuation or other independent work stays; a stale stage is
 *   removed; a wake left without comments gets the reason of what it carries.
 * `judgedStage` tells whether the result read the issue row. The caller
 * writes every result only if neither the wake row nor the issue row changed
 * since it read them: a decision made on an older wake must not overwrite
 * work merged into it after the read.
 */
export function settleWakeAfterDeliveredComments(
  wake: StoredWake & { rowReason: string | null },
  issue: ExecutionWakeFreshnessFacts["issue"],
): { judgedStage: boolean } & ({ kind: "cancel_delivered" } | { kind: "cancel_stale" } | { kind: "store"; payload: Record<string, unknown> }) {
  const drainWake = asDrainWake(wake);
  const freshness = decideExecutionWakeFreshness({ wake: { agentId: wake.agentId, payload: drainWake.payload }, issue });
  const judgedStage = freshness !== "not_applicable";
  const queued = Array.isArray(drainWake.deferredContextSeed.wakeCommentIds) ? drainWake.deferredContextSeed.wakeCommentIds.length : 0;
  const independent = deferredWakePreservesIndependentContinuation({ rowReason: wake.rowReason, deferredContextSeed: drainWake.deferredContextSeed }) ||
    freshness === "current" || carriesRunLivenessContinuation(drainWake.deferredContextSeed);
  if (queued === 0 && !independent) return { judgedStage, kind: "cancel_delivered" };
  if (freshness === "stale") return { judgedStage, kind: "cancel_stale" };
  return { judgedStage, kind: "store", payload: storedPayloadWithoutStaleStage(wake, issue) };
}

/**
 * Whether a deferred wake carries work that adopting only its queued comment
 * IDs into another wake's run would lose: a saved execution stage (current or
 * not; the release drain judges it under the issue lock) or a run liveness
 * continuation. A merged wake can show a comment reason and still carry
 * either, in both merge orders.
 */
export function carriesWorkBeyondQueuedComments(payload: unknown) {
  const stored = parseObject(payload);
  const seed = parseObject(stored._paperclipWakeContext);
  return savedStage(stored, seed) !== null || carriesRunLivenessContinuation(seed);
}

/**
 * A saved receipt resumed through admission (`executionWaitRequestId`) still
 * carries the stage it was saved with. Judged against the issue row admission
 * holds locked: a stage that has moved on is removed from both the outgoing
 * payload and the run context, so the receipt's own work (the comment, retry
 * or click that passed admission) is delivered without the old instructions.
 * A current stage, or a wake with no saved stage, is returned unchanged.
 */
export function withoutStaleStageOnResumedReceipt(
  receipt: { agentId: string; payload: Record<string, unknown>; contextSnapshot: Record<string, unknown> },
  issue: ExecutionWakeFreshnessFacts["issue"],
): { payload: Record<string, unknown>; contextSnapshot: Record<string, unknown>; strippedStage: boolean } {
  const unchanged = { payload: receipt.payload, contextSnapshot: receipt.contextSnapshot, strippedStage: false };
  if (judgeStage({ wake: { agentId: receipt.agentId, payload: receipt.payload }, issue }).current !== false) return unchanged;
  const strip = (seed: Record<string, unknown>) => withoutStaleExecutionContext({ agentId: receipt.agentId,
    payload: receipt.payload, deferredContextSeed: seed, wakeReason: readNonEmptyString(seed.wakeReason) }, issue);
  const payload = strip(parseObject(receipt.payload._paperclipWakeContext)).payload;
  const contextSnapshot = strip(receipt.contextSnapshot).deferredContextSeed;
  return { payload, contextSnapshot, strippedStage: true };
}
