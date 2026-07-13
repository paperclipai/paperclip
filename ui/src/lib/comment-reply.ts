import type { Agent, IssueComment, IssueCommentReplyToMetadata } from "@paperclipai/shared";

/**
 * Max characters shown in a reply excerpt (composer chip + sent quoted header).
 * Mirrors the server-authored snapshot length so optimistic and persisted quotes match.
 */
export const REPLY_EXCERPT_MAX_LENGTH = 200;

/** Collapse markdown/whitespace into a single-line excerpt clamped to {@link REPLY_EXCERPT_MAX_LENGTH}. */
export function buildReplyExcerpt(body: string): { excerpt: string; truncated: boolean } {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= REPLY_EXCERPT_MAX_LENGTH) {
    return { excerpt: normalized, truncated: false };
  }
  return { excerpt: normalized.slice(0, REPLY_EXCERPT_MAX_LENGTH).trimEnd(), truncated: true };
}

/**
 * Build the reply snapshot the server will also produce, so the sent quote renders immediately
 * (optimistic update) and stays consistent after the authoritative refetch.
 */
export function buildOptimisticReplyTo(target: IssueComment): IssueCommentReplyToMetadata {
  const { excerpt, truncated } = buildReplyExcerpt(target.body);
  return {
    commentId: target.id,
    authorType: target.authorType,
    authorAgentId: target.authorAgentId ?? null,
    authorUserId: target.authorUserId ?? null,
    excerpt,
    excerptTruncated: truncated,
  };
}

/**
 * Human-readable author label for a reply target. Mirrors {@link CommentCard}'s author rendering:
 * agent comments show the agent name, everything else collapses to "You".
 */
export function formatReplyAuthorName(
  replyTo: Pick<IssueCommentReplyToMetadata, "authorType" | "authorAgentId">,
  agentMap?: Map<string, Agent>,
): string {
  if (replyTo.authorAgentId) {
    return agentMap?.get(replyTo.authorAgentId)?.name ?? replyTo.authorAgentId.slice(0, 8);
  }
  if (replyTo.authorType === "system") return "System";
  return "You";
}
