import { handledInTurn, readCurrentRevision, wakeMarksEarlierRead } from "./runtime-queue.js";

export type QueuedFollowUp = { id: string; updatedAt?: unknown; body?: string };
export type CommentReceipts = { reads?: Record<string, string>; cited?: string[] };
export type ContinuationInput = {
  contextSnapshot?: { wakeCommentIds?: string[]; paperclipWake?: { comments?: Array<{ id?: string; readByEarlierTurn?: boolean }> } };
  prompt?: string;
};

export function owedAfterTurn<T extends QueuedFollowUp>(queued: readonly T[], receipts: CommentReceipts | undefined) {
  return queued.filter(row => !handledInTurn(receipts, row));
}

function carries(prompt: string | undefined, body: string | undefined) {
  return !!prompt && !!body?.trim() && (prompt.includes(body) || prompt.includes(JSON.stringify(body).slice(1, -1)));
}

export function continuationCarriesOwed(queued: readonly QueuedFollowUp[], receipts: CommentReceipts | undefined, run: ContinuationInput | undefined) {
  const owed = owedAfterTurn(queued, receipts), handled = queued.filter(row => !owed.includes(row)), ids = run?.contextSnapshot?.wakeCommentIds ?? [];
  return owed.length > 0 && owed.every(row => ids.filter(id => id === row.id).length === 1 && carries(run?.prompt, row.body)
    && (!readCurrentRevision(receipts?.reads, row) || wakeMarksEarlierRead(run?.contextSnapshot, row.id)))
    && handled.every(row => !ids.includes(row.id));
}
