/**
 * Helpers for continuation recovery loop guard (dedupe self-sustaining continuation wakes).
 */
/** Bag-of-words cosine; ~0.75+ matches terse paraphrases with shared vocabulary. */
export const CONTINUATION_LOOP_GUARD_SIMILARITY_THRESHOLD = 0.75;

export function normalizeContinuationLoopGuardComment(body: string) {
  return body
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi, "<timestamp>")
    .replace(/\b(?:run|comment|heartbeat|wake)[-_ ]?(?:id)?[:#]?\s*[a-z0-9_-]{6,}\b/gi, "<volatile-id>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[^\p{L}\p{N}<>\s_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cosineSimilarity(left: string, right: string) {
  const leftTokens = left.split(/\s+/).filter(Boolean);
  const rightTokens = right.split(/\s+/).filter(Boolean);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const token of leftTokens) leftCounts.set(token, (leftCounts.get(token) ?? 0) + 1);
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);

  let dot = 0;
  for (const [token, count] of leftCounts) {
    dot += count * (rightCounts.get(token) ?? 0);
  }
  const leftMagnitude = Math.sqrt([...leftCounts.values()].reduce((sum, count) => sum + count * count, 0));
  const rightMagnitude = Math.sqrt([...rightCounts.values()].reduce((sum, count) => sum + count * count, 0));
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (leftMagnitude * rightMagnitude);
}

export function areContinuationLoopGuardCommentsSimilar(leftBody: string, rightBody: string) {
  const left = normalizeContinuationLoopGuardComment(leftBody);
  const right = normalizeContinuationLoopGuardComment(rightBody);
  if (!left || !right) return false;
  return left === right || cosineSimilarity(left, right) >= CONTINUATION_LOOP_GUARD_SIMILARITY_THRESHOLD;
}
