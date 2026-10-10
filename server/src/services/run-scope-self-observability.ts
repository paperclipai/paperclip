/**
 * Lets a heartbeat run read its own issue scope.
 *
 * A sandboxed run connects to the control plane through the callback bridge. The route
 * allowlist of the bridge refuses all the run-introspection routes:
 * `GET /api/heartbeat-runs/:runId`, `/issues/:id/runs`, `/issues/:id/active-run` and
 * `/companies/:id/heartbeat-runs`. The `heartbeat-context` route is permitted, but it
 * gave no run data. Thus a sandboxed run could not answer one question about itself:
 * "is my run scoped to an issue?"
 *
 * That question is necessary. If a test cannot read its own run scope, it cannot show
 * that it used the unscoped-run code path. A pass then proves nothing.
 *
 * This service reads only the run of the caller. It gives one scope fact. It does not
 * give a run record.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { readRunSourceIssueId, runScopeIsIssue } from "./cross-issue-influence-limit.js";

/**
 * What the calling run can prove about its own issue scope.
 *
 * `runResolved` guards the rest: `scoped`, `scopedIssueId` and `scopedToThisIssue` are
 * `null` whenever the caller's run could not be read, so "my run is unscoped" can never
 * be confused with "I could not tell". A verifier that treats a missing scope as an
 * unscoped run would otherwise record a pass against a path it never exercised, which is
 * the exact failure this field exists to remove.
 */
export interface SelfRunScope {
  /**
   * The caller's own heartbeat run id, or `null` when the actor layer produced none.
   *
   * For agent-JWT callers this comes from the signed `run_id` claim, so it is the
   * caller's own run by construction. For legacy API-key callers it comes from the
   * `X-Paperclip-Run-Id` header, which the sandbox callback bridge strips — `null` there
   * is the honest answer, not an error.
   */
  runId: string | null;
  /** Whether `runId` resolved to a run of this agent in this company. */
  runResolved: boolean;
  /** Whether that run carries an issue scope. `null` when `runResolved` is false. */
  scoped: boolean | null;
  /**
   * The scoped issue id — `null` on an unscoped run and when `runResolved` is false.
   *
   * Verbatim from `contextSnapshot`, so it can be a human identifier rather than a uuid.
   * Compare with `scopedToThisIssue` rather than by hand; that field uses the guard's own
   * predicate, which accepts either form.
   */
  scopedIssueId: string | null;
  /** Whether the run's scope is the issue being read. `null` when `runResolved` is false. */
  scopedToThisIssue: boolean | null;
}

function unresolved(runId: string | null): SelfRunScope {
  return {
    runId,
    runResolved: false,
    scoped: null,
    scopedIssueId: null,
    scopedToThisIssue: null,
  };
}

/**
 * Reads the calling agent's own run scope, for the issue it is reading.
 *
 * Self-only by construction: the run is looked up by the actor's own run id, agent id and
 * company id together, so an id belonging to another agent or another company resolves to
 * nothing and reports `runResolved: false` — it never discloses that run's scope.
 *
 * Returns `null` for non-agent callers, who have no heartbeat run to report.
 */
export async function resolveSelfRunScope(
  db: Db,
  input: {
    actor: { actorType: "agent" | "user"; agentId: string | null; runId: string | null };
    companyId: string;
    issue: { id: string; identifier?: string | null };
  },
): Promise<SelfRunScope | null> {
  const { actor } = input;
  if (actor.actorType !== "agent") return null;

  const runId = actor.runId;
  // Reject a malformed id before the database can turn it into a PostgreSQL cast error,
  // the same way `observeCrossIssueInfluence` does. An unusable id is still reported
  // back, because "the id I am carrying is this, and it resolved to nothing" is the
  // observation a caller needs; only a missing id reports `null`.
  if (!runId) return unresolved(null);
  if (!isUuidLike(runId)) return unresolved(runId);
  if (!actor.agentId) return unresolved(runId);

  const run = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!run) return unresolved(runId);

  const scopedIssueId = readRunSourceIssueId(run.contextSnapshot);
  return {
    runId,
    runResolved: true,
    scoped: scopedIssueId !== null,
    scopedIssueId,
    scopedToThisIssue: runScopeIsIssue(scopedIssueId, input.issue),
  };
}
