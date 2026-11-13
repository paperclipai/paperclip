import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";

/**
 * How long a queued follow-up waits before it is steered into the live turn,
 * so its author can still edit or cancel it. The agent reads a steered message
 * only at its next model step, so this costs at most this long and nothing
 * while a tool call is still running (measured: 0.8 s steering acknowledgement,
 * 7–14 s saved per Codex follow-up).
 */
export const QUEUED_MESSAGE_AUTO_STEER_DELAY_MS = 5_000;

/**
 * When the entry's current text may be steered: the delay after its last
 * change, but never before the delay after this view first offered it. A
 * message that waited while steering was unavailable still shows its full
 * countdown, with Edit and Cancel, before it is sent.
 */
export function queuedMessageAutoSteerDeadline(entry: IssueQueuedCommentEntry, firstEligibleAtMs: number,
  delayMs = QUEUED_MESSAGE_AUTO_STEER_DELAY_MS): number {
  const changedAt = Math.max(Date.parse(String(entry.comment.createdAt)), Date.parse(String(entry.comment.updatedAt ?? entry.comment.createdAt)));
  return Math.max(Number.isFinite(changedAt) ? changedAt : 0, firstEligibleAtMs) + delayMs;
}

/** The revision key one automatic attempt is limited to. */
export function queuedMessageAutoSteerKey(entry: IssueQueuedCommentEntry): string {
  return `${entry.comment.id}:${String(entry.comment.updatedAt ?? entry.comment.createdAt)}`;
}

/**
 * Only the author's own plain follow-up, while the runner can take same-turn
 * input. Everything else keeps the ordinary queue (Steer and Interrupt stay
 * explicit).
 */
export function queuedMessageAutoSteerEligible(input: {
  queue: IssueQueuedCommentQueue;
  entry: IssueQueuedCommentEntry;
  cancelledIds: ReadonlySet<string>;
  attemptedKeys: ReadonlySet<string>;
  editingCommentId: string | null;
}): boolean {
  const { queue, entry } = input;
  return queue.steeringDisposition === "available"
    && Boolean(queue.queueId && queue.targetRunId)
    && queue.protocol === "paperclip_runner_v1"
    && entry.canEdit
    && entry.source?.kind !== "interaction"
    && !entry.source?.requiresFreshSession
    && !entry.comment.id.startsWith("optimistic-")
    && !input.cancelledIds.has(entry.comment.id)
    && !input.attemptedKeys.has(queuedMessageAutoSteerKey(entry))
    && input.editingCommentId !== entry.comment.id;
}
