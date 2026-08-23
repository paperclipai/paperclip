import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  type CrossIssueWriteGrantDecision,
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

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
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
    now?: Date;
    enforceGrantAt?: Date | null;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  const outcome = await db.transaction(async (tx): Promise<
    { grantDenied: CrossIssueWriteGrantDecision; sourceIssueId: string } | { decision: CrossIssueInfluenceDecision | null }
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
      }),
      now: input.now,
      enforceAt: input.enforceGrantAt,
    });
    if (!grant.allowed) {
      // The audit row is written outside this transaction: the refusal throws,
      // and a rollback would take the evidence of the refusal with it.
      return { grantDenied: grant, sourceIssueId };
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
            sourceIssueId,
            targetIssueId: input.targetIssueId,
            targetIssueIdentifier: input.targetIssueIdentifier ?? null,
            basis: null,
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

    return { decision };
  });

  if ("grantDenied" in outcome) {
    await auditCrossIssueWriteGrantDenied(db, input, outcome.grantDenied, outcome.sourceIssueId);
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
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        basis: null,
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
