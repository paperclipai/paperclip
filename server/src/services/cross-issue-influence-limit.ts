import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  type CrossIssueWriteGrantDecision,
  type CrossIssueWriteOperation,
  evaluateCrossIssueWriteGrant,
  resolveCrossIssueWriteBasis,
} from "./cross-issue-write-basis.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";
const CROSS_ISSUE_WRITE_GRANT_DENIED_ACTIVITY = "issue.cross_issue_write_grant_denied";
const CROSS_ISSUE_WRITE_GRANT_WOULD_DENY_ACTIVITY = "issue.cross_issue_write_grant_would_deny";

/**
 * Every kind shares one per-run counter. `interaction_resolution` covers the
 * issue-thread accept/reject/respond/verdict routes: an open `anyone` resolver
 * audience is not a licence to resolve, wake, and spawn suggested tasks across
 * the whole company from one run.
 */
export type CrossIssueInfluenceKind = "comment" | "update" | "interaction_resolution";

/**
 * A comment adds a message to someone else's thread; a PATCH or an interaction
 * resolution changes their ticket's state. The second needs a basis that names
 * authority over the target, not just a relationship to it — see
 * `CROSS_ISSUE_WRITE_COMMENT_ONLY_BASES`.
 *
 * This is the *default* grade for a route, not the last word. `POST /comments`
 * is not always a pure comment: `resume`/`reopen`, an implicit move-to-todo, a
 * superseded scheduled retry, and a closed-workspace reopen all mutate the
 * target. Callers pass an explicit `operation` when the request body says the
 * write does more than add a message, so authority is graded by effect rather
 * than by endpoint (FAI-10134 blocking finding 1).
 */
export function crossIssueWriteOperationForKind(kind: CrossIssueInfluenceKind): CrossIssueWriteOperation {
  return kind === "comment" ? "comment" : "mutation";
}

/**
 * Everything the persistence-time re-check needs to resolve the same decision
 * again, under locks, inside the transaction that actually writes. Produced only
 * when enforcement is armed — in observe mode the re-check could not refuse
 * anything, so it is not worth the queries.
 */
export type CrossIssueWriteFence = {
  companyId: string;
  runId: string;
  agentId: string;
  responsibleUserId: string | null;
  sourceIssueId: string;
  targetIssueId: string;
  targetIssueIdentifier: string | null;
  kind: CrossIssueInfluenceKind;
  /**
   * The grade the gate resolved against. Carried on the fence so the
   * persistence-time re-check cannot silently re-resolve a mutating comment as
   * comment-grade and re-admit the write the gate refused.
   */
  operation: CrossIssueWriteOperation;
  /** The basis that held at cap time, for the drift audit row. */
  basisAtCheck: CrossIssueWriteGrantDecision["basis"];
  enforceAt: string | null;
};

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
  /**
   * Present when enforcement is armed. The route must re-assert it inside the
   * transaction that persists the write — see `assertCrossIssueWriteFence`.
   */
  fence?: CrossIssueWriteFence | null;
};

export function crossIssueWriteGrantError(context: { issueIdentifier?: string | null } = {}) {
  // A 403 boundary, deliberately not the cap's 429: retrying next heartbeat
  // will not help, so the copy has to point at the grant instead of the budget.
  const { body } = issueWriteDenialResponse("cross_issue_write_grant_required", context);
  return forbidden(body.error, body.details);
}

export function crossIssueInfluenceRunContextError() {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required");
  return forbidden(body.error, body.details);
}

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= CROSS_ISSUE_INFLUENCE_LIMIT,
    mode,
    count: nextCount,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
  };
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 *
 * Authority is resolved *before* the counter (FAI-10132): the 20-per-run cap is
 * a rate backstop on writes the agent is allowed to make, so spending budget on
 * a write that has no basis would conflate "out of budget" with "not permitted"
 * in both the audit trail and the error an agent reads.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    /**
     * Overrides the route's default grade when the request's effects are wider
     * than its endpoint — a `POST /comments` that also moves the target to
     * `todo` is a mutation and must be authorized as one.
     */
    operation?: CrossIssueWriteOperation;
    now?: Date;
    enforceGrantAt?: Date | null;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  const operation = input.operation ?? crossIssueWriteOperationForKind(input.kind);

  const outcome = await db.transaction(async (tx): Promise<
    | { grantDenied: CrossIssueWriteGrantDecision; sourceIssueId: string; runResponsibleUserId: string | null }
    | { decision: CrossIssueInfluenceDecision | null }
  > => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      throw crossIssueInfluenceRunContextError();
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) throw crossIssueInfluenceRunContextError();
    if (
      sourceIssueId === input.targetIssueId ||
      (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
    ) {
      return { decision: null };
    }

    const grant = evaluateCrossIssueWriteGrant({
      authority: await resolveCrossIssueWriteBasis(tx, {
        companyId: input.companyId,
        actorAgentId: input.agentId,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        operation,
      }),
      now: input.now,
      enforceAt: input.enforceGrantAt,
    });
    if (!grant.allowed) {
      // The audit row is written outside this transaction: the refusal throws,
      // and a rollback would take the evidence of the refusal with it. The run's
      // responsible user rides along because the row is written after the
      // locked run row is out of scope, and a denial must not lose delegated
      // attribution the allowed rows keep.
      return { grantDenied: grant, sourceIssueId, runResponsibleUserId: run.responsibleUserId ?? null };
    }
    if (grant.basis === null) {
      // Shadow phase. The write proceeds exactly as it does today; this row is
      // the only record that enforcement would have stopped it, and it is the
      // dataset the cutover decision is made from. Best-effort: a failed audit
      // insert must not turn a currently-legal write into a 500.
      try {
        await tx.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
          action: CROSS_ISSUE_WRITE_GRANT_WOULD_DENY_ACTIVITY,
          entityType: "issue",
          entityId: input.targetIssueId,
          details: {
            kind: input.kind,
            operation,
            sourceIssueId,
            targetIssueId: input.targetIssueId,
            targetIssueIdentifier: input.targetIssueIdentifier ?? null,
            basis: null,
            commentOnlyBasis: grant.commentOnlyBasis,
            targetAssigneeUserId: grant.targetAssigneeUserId,
            grantMode: grant.mode,
            grantEnforceAt: grant.enforceAt,
          },
        });
      } catch (err) {
        logger.warn(
          { err, companyId: input.companyId, agentId: input.agentId, targetIssueId: input.targetIssueId },
          "Failed to audit a shadow-phase cross-issue write with no grant basis",
        );
      }
      logger.warn({
        event: "cross_issue_write_grant",
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        kind: input.kind,
        basis: null,
        commentOnlyBasis: grant.commentOnlyBasis,
        mode: grant.mode,
        enforceAt: grant.enforceAt,
      }, "cross-issue write has no grant basis and would be denied under enforcement");
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
      action: decision.allowed
        ? CROSS_ISSUE_INFLUENCE_ACTIVITY
        : CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        operation,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        count: decision.count,
        cap: decision.cap,
        mode: decision.mode,
        enforceAt: decision.enforceAt,
        allowed: decision.allowed,
        basis: grant.basis,
        grantMode: grant.mode,
      },
    });

    const logContext = {
      event: "cross_issue_influence_cap",
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      sourceIssueId,
      targetIssueId: input.targetIssueId,
      kind: input.kind,
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
      allowed: decision.allowed,
      basis: grant.basis,
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    // The fence exists only to be re-asserted under locks at persistence time,
    // and only enforcement can act on it. In observe mode the re-check could
    // refuse nothing, so it is not worth the extra statements.
    const fence: CrossIssueWriteFence | null = grant.mode === "enforce"
      ? {
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
        responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        kind: input.kind,
        operation,
        basisAtCheck: grant.basis,
        enforceAt: grant.enforceAt,
      }
      : null;

    return { decision: { ...decision, fence } };
  });

  if ("grantDenied" in outcome) {
    await auditCrossIssueWriteGrantDenied(db, {
      ...input,
      operation,
      responsibleUserId: input.responsibleUserId ?? outcome.runResponsibleUserId,
    }, outcome.grantDenied, outcome.sourceIssueId);
    throw crossIssueWriteGrantError({ issueIdentifier: input.targetIssueIdentifier ?? null });
  }
  return outcome.decision;
}

/**
 * Audit an enforced refusal. Best-effort by design: losing the row is bad, but
 * turning a clean 403 into a 500 is worse, and the refusal itself already
 * happened inside the committed transaction's decision.
 */
async function auditCrossIssueWriteGrantDenied(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    operation: CrossIssueWriteOperation;
  },
  grant: CrossIssueWriteGrantDecision,
  sourceIssueId: string,
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? null,
      action: CROSS_ISSUE_WRITE_GRANT_DENIED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        operation: input.operation,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        basis: null,
        commentOnlyBasis: grant.commentOnlyBasis,
        grantMode: grant.mode,
        grantEnforceAt: grant.enforceAt,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, targetIssueId: input.targetIssueId },
      "Failed to audit a denied cross-issue write",
    );
  }
  logger.warn({
    event: "cross_issue_write_grant",
    companyId: input.companyId,
    runId: input.runId,
    agentId: input.agentId,
    sourceIssueId,
    targetIssueId: input.targetIssueId,
    kind: input.kind,
    basis: null,
    mode: grant.mode,
    enforceAt: grant.enforceAt,
  }, "cross-issue write denied: no grant basis");
}

const CROSS_ISSUE_WRITE_GRANT_REVOKED_ACTIVITY = "issue.cross_issue_write_grant_revoked_in_flight";

/**
 * Re-assert the authority the cap gate resolved, inside the transaction that is
 * about to persist the write, with `FOR SHARE` on every row the decision reads
 * (FAI-10134 blocking finding 1).
 *
 * `tx` must be the persistence transaction: the locks it takes are what makes
 * this binding. A reassignment, reparent, or grant revocation racing the write
 * either commits before these locks — in which case the re-resolution sees it,
 * this throws, and drizzle rolls the mutation back with zero rows written — or
 * it blocks behind them until the mutation commits. `auditDb` is the pooled
 * handle, deliberately *not* `tx`, so the evidence row survives that rollback.
 */
export async function assertCrossIssueWriteFence(
  auditDb: Db,
  tx: Parameters<typeof resolveCrossIssueWriteBasis>[0],
  fence: CrossIssueWriteFence | null | undefined,
) {
  if (!fence) return;
  const authority = await resolveCrossIssueWriteBasis(
    tx,
    {
      companyId: fence.companyId,
      actorAgentId: fence.agentId,
      sourceIssueId: fence.sourceIssueId,
      targetIssueId: fence.targetIssueId,
      operation: fence.operation,
    },
    { lockAuthorityInputs: true },
  );
  if (authority.basis !== null) return;

  const context = {
    event: "cross_issue_write_grant",
    companyId: fence.companyId,
    runId: fence.runId,
    agentId: fence.agentId,
    sourceIssueId: fence.sourceIssueId,
    targetIssueId: fence.targetIssueId,
    kind: fence.kind,
    basisAtCheck: fence.basisAtCheck,
    basisAtWrite: null,
    enforceAt: fence.enforceAt,
  };
  try {
    await auditDb.insert(activityLog).values({
      companyId: fence.companyId,
      actorType: "agent",
      actorId: fence.agentId,
      agentId: fence.agentId,
      runId: fence.runId,
      responsibleUserId: fence.responsibleUserId,
      action: CROSS_ISSUE_WRITE_GRANT_REVOKED_ACTIVITY,
      entityType: "issue",
      entityId: fence.targetIssueId,
      details: {
        kind: fence.kind,
        operation: fence.operation,
        sourceIssueId: fence.sourceIssueId,
        targetIssueId: fence.targetIssueId,
        targetIssueIdentifier: fence.targetIssueIdentifier,
        basisAtCheck: fence.basisAtCheck,
        basisAtWrite: null,
        commentOnlyBasis: authority.commentOnlyBasis ?? null,
        targetAssigneeUserId: authority.targetAssigneeUserId ?? null,
        grantMode: "enforce",
        grantEnforceAt: fence.enforceAt,
      },
    });
  } catch (err) {
    logger.warn({ ...context, err }, "Failed to audit a cross-issue write refused for revoked authority");
  }
  logger.warn(context, "cross-issue write refused: authority revoked between the cap gate and the write");
  throw crossIssueWriteGrantError({ issueIdentifier: fence.targetIssueIdentifier });
}

export function crossIssueInfluenceLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null; assigneeLabel?: string | null; issueIdentifier?: string | null } = {},
) {
  // The cap is a rate backstop, not a permission decision — the shared copy
  // contract says so explicitly, and names the next run as the way forward.
  const { body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
    ...context,
    cap: decision.cap,
    count: decision.count,
    enforceAt: decision.enforceAt,
  });
  return {
    error: body.error,
    details: {
      ...body.details,
      cap: decision.cap,
      count: decision.count,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
    },
  };
}
