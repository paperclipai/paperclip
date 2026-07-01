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
 * Two-signal recognition (covers BOTH MCP-routed and shell-routed writes)
 * ----------------------------------------------------------------------
 * On `local_trusted` the agent has two materially different write paths:
 *
 *   - MCP-routed (`paperclipAddComment` etc.) — the comment row gets
 *     `author_agent_id = <the agent>`, `author_user_id = NULL`, and
 *     `created_by_run_id` linked to the current heartbeat run.
 *   - Shell-routed (`curl` from the agent's terminal with the agent's
 *     Bearer authToken) — the auth middleware's `local_trusted`
 *     short-circuit promotes the actor to the `local-board` USER principal,
 *     so the comment row gets `author_agent_id = NULL`,
 *     `author_user_id = "local-board"`, and `created_by_run_id` STILL linked
 *     to the agent's heartbeat run.
 *
 * The first signal (`author_agent_id === assigneeAgentId`) catches MCP-routed
 * self-comments. The second signal (`createdByRunAgentId === assigneeAgentId`)
 * catches shell-routed self-comments, because while the auth middleware loses
 * the agent identity, the heartbeat-run reference is set by the run-level
 * comment plumbing and survives. A comment is self-authored when EITHER signal
 * fires.
 *
 * The helper is intentionally pure so it can be unit-tested without database
 * fixtures. The caller (`heartbeat.ts`) is responsible for the lookup (which
 * is a single `LEFT JOIN` between `issue_comments` and `heartbeat_runs`).
 */

export interface DeferredCommentAuthorRow {
  /** `issue_comments.id` */
  id: string;
  /**
   * `issue_comments.author_agent_id` — null for human-authored comments AND
   * for agent-authored comments that round-tripped through a path which lost
   * agent identity (see "shell-routed" in the file header).
   */
  authorAgentId: string | null;
  /**
   * `heartbeat_runs.agent_id` joined via `issue_comments.created_by_run_id`.
   * Null if the comment was not created during an agent run (e.g. a real
   * human comment posted from the dashboard), or if the run is missing/deleted.
   */
  createdByRunAgentId: string | null;
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
   * The lookup result of:
   *
   *   SELECT ic.id,
   *          ic.author_agent_id          AS authorAgentId,
   *          hr.agent_id                 AS createdByRunAgentId
   *   FROM   issue_comments ic
   *   LEFT JOIN heartbeat_runs hr ON hr.id = ic.created_by_run_id
   *   WHERE  ic.id IN (deferredCommentIds);
   *
   * Order does not matter.
   */
  deferredCommentAuthors: ReadonlyArray<DeferredCommentAuthorRow>;
}

/**
 * Returns `true` only when EVERY deferred-wake comment was authored by the
 * assignee agent itself (a "self-comment wake"). Such wakes must never reopen
 * a done/cancelled issue, regardless of the wake's recorded `actor_type`.
 *
 * A single comment counts as self-authored when EITHER:
 *   - `authorAgentId === assigneeAgentId` (the MCP-routed path preserves
 *     agent identity), OR
 *   - `createdByRunAgentId === assigneeAgentId` (the shell-routed path loses
 *     agent identity at the auth layer but the run linkage survives).
 *
 * Returns `false` when:
 *   - There are no deferred comment IDs (the wake isn't comment-driven at all).
 *   - The issue has no assignee agent (no agent can have authored the comments).
 *   - The lookup returned fewer rows than IDs requested (missing or deleted
 *     comments; treat as "unknown" and let the existing predicate decide
 *     conservatively rather than skipping a possibly-legitimate reopen).
 *   - At least one comment was authored by someone other than the assignee
 *     by BOTH signals (i.e. neither `authorAgentId` nor `createdByRunAgentId`
 *     equals the assignee). This is a real human comment or a comment created
 *     by a different agent's run.
 */
export function isExclusivelySelfAuthoredDeferredCommentWake(
  input: SelfAuthoredDeferredCommentWakeInput,
): boolean {
  if (input.deferredCommentIds.length === 0) return false;
  if (!input.assigneeAgentId) return false;
  if (input.deferredCommentAuthors.length !== input.deferredCommentIds.length) {
    return false;
  }
  const assigneeAgentId = input.assigneeAgentId;
  return input.deferredCommentAuthors.every(
    (row) =>
      row.authorAgentId === assigneeAgentId ||
      row.createdByRunAgentId === assigneeAgentId,
  );
}
