export const LEGACY_WITHHELD_RUN_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

export function presentationDecisionCommentId(
  value: unknown,
): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const decision = (value as Record<string, unknown>).presentationDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision))
    return undefined;
  const record = decision as Record<string, unknown>;
  if (record.schema !== "paperclip.run_presentation_decision.v1")
    return undefined;
  return typeof record.commentId === "string" && record.commentId.trim()
    ? record.commentId
    : null;
}

export function semanticProgressCommentIds(value: unknown): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new Set();
  const receipts = (value as Record<string, unknown>).semanticToolReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts))
    return new Set();
  const ids = new Set<string>();
  for (const receipt of Object.values(receipts)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      continue;
    const record = receipt as Record<string, unknown>;
    if (record.operationId !== "report_progress") continue;
    const result = record.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      continue;
    const commentId = (result as Record<string, unknown>).commentId;
    if (typeof commentId === "string" && commentId) ids.add(commentId);
  }
  return ids;
}

export function hasVisibleRunAnswer(
  comments: ReadonlyArray<{
    id: string;
    authorType: string;
    body: string;
    deletedAt?: Date | string | null;
    runId?: string | null;
    createdByRunId?: string | null;
    derivedCreatedByRunId?: string | null;
  }>,
  runId: string,
  resultJson: unknown,
): boolean {
  const presentationCommentId = presentationDecisionCommentId(resultJson);
  const progressCommentIds = semanticProgressCommentIds(resultJson);
  return comments.some(comment =>
    comment.authorType === "agent" && !comment.deletedAt && comment.body.trim() &&
    comment.body !== LEGACY_WITHHELD_RUN_COMMENT && !progressCommentIds.has(comment.id) &&
    (comment.runId ?? comment.createdByRunId ?? comment.derivedCreatedByRunId) === runId &&
    (presentationCommentId === undefined || presentationCommentId === comment.id),
  );
}
