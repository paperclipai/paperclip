/**
 * Helper for the deferred-comment-wake promotion path in `heartbeat.ts`.
 *
 * Background
 * ----------
 * When a comment is posted on an issue assigned to an agent, Paperclip queues a
 * `deferred_issue_execution` wakeup so the agent can react to the new comment.
 * When that deferred wake is later promoted, the promoter must decide whether
 * to also reopen the issue if it has reached a terminal status (`done` or
 * `cancelled`). The original predicate distinguished "real human commenter
 * wants the issue reopened" from "system follow-up that should respect the
 * disposition" by reading `agent_wakeup_requests.requested_by_actor_type` —
 * trusting that actor-type to identify whether the triggering write came from
 * a user or an agent.
 *
 * Why that trust was wrong
 * ------------------------
 * On `deploymentMode: "local_trusted"` instances, the auth middleware
 * (`server/src/middleware/auth.ts`) short-circuits unauthenticated localhost
 * requests to the `local-board` USER principal. Adapters that present a raw
 * `Authorization: Bearer <agent authToken>` (notably `hermes-paperclip-adapter`
 * v0.2.0 on `hermes_local`) do not promote that token to an agent JWT, so the
 * agent's own writes record `requested_by_actor_type: "user"`. The predicate
 * then mistakes the agent's own DONE-summary comment for a real human commenter
 * and reopens the just-completed issue — which causes the agent to wake again,
 * post another DONE-summary comment, and infinite-loop. See:
 *   - paperclipai/paperclip#3980 (root cause: identity attribution)
 *   - paperclipai/paperclip#3935 (symptom: Done -> In Progress oscillation)
 *   - paperclipai/paperclip#2486 (general class: infinite promotion loops)
 *   - NousResearch/hermes-paperclip-adapter#92 (adapter-side mirror)
 *
 * Why this helper is the right fix
 * --------------------------------
 * The comment table holds the authoritative author identity
 * (`issue_comments.author_agent_id`). It does not lie about who authored the
 * comment regardless of how the auth middleware classified the request. By
 * looking up the actual comment authors for the deferred wake's comment IDs
 * and asking "were these comments exclusively written by the assignee agent
 * itself?", we get a content-based signal that is independent of the wake's
 * recorded actor-type and the deployment mode. The original actor-type check
 * remains as defense-in-depth; this helper adds the missing second check.
 *
 * The helper is intentionally pure so it can be unit-tested without database
 * fixtures. The caller (`heartbeat.ts`) is responsible for the lookup.
 */

export interface DeferredCommentAuthorRow {
  /** `issue_comments.id` */
  id: string;
  /** `issue_comments.author_agent_id` — null for human-authored comments */
  authorAgentId: string | null;
}

export interface SelfAuthoredDeferredCommentWakeInput {
  /** Comment IDs extracted from the deferred wake's context snapshot. */
  deferredCommentIds: ReadonlyArray<string>;
  /**
   * The issue's current `assignee_agent_id`. Null/undefined means the issue is
   * not assigned to an agent; in that case the wake cannot be "self-authored"
   * by anyone, so we return false and let the existing predicate decide.
   */
  assigneeAgentId: string | null | undefined;
  /**
   * The lookup result of `SELECT id, author_agent_id FROM issue_comments WHERE
   * id IN (deferredCommentIds)`. The caller performs this lookup; we just
   * compare. Order does not matter.
   */
  deferredCommentAuthors: ReadonlyArray<DeferredCommentAuthorRow>;
}

/**
 * Returns `true` only when EVERY deferred-wake comment was authored by the
 * assignee agent itself (a "self-comment wake"). Such wakes must never reopen
 * a done/cancelled issue, regardless of the wake's recorded `actor_type`.
 *
 * Returns `false` when:
 *   - There are no deferred comment IDs (the wake isn't comment-driven at all).
 *   - The issue has no assignee agent (no agent can have authored the comments).
 *   - The lookup returned fewer rows than IDs requested (missing or deleted
 *     comments; treat as "unknown" and let the existing predicate decide
 *     conservatively rather than skipping a possibly-legitimate reopen).
 *   - At least one comment was authored by someone other than the assignee
 *     (a real human comment or a different agent's comment is in the batch).
 */
export function isExclusivelySelfAuthoredDeferredCommentWake(
  input: SelfAuthoredDeferredCommentWakeInput,
): boolean {
  if (input.deferredCommentIds.length === 0) return false;
  if (!input.assigneeAgentId) return false;
  if (input.deferredCommentAuthors.length !== input.deferredCommentIds.length) {
    return false;
  }
  return input.deferredCommentAuthors.every(
    (row) => row.authorAgentId === input.assigneeAgentId,
  );
}
