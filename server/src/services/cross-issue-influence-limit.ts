import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  agentRunLookupId,
  hasAgentWriteRunAuthority,
  recordDurableWriteDenialOnActiveRun,
} from "./agent-run-authority.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

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

type RunContextDenial = {
  reason: "malformed_run_id" | "run_not_found" | "run_not_live" | "run_missing_issue_context";
  runExists: boolean;
  runStatus: string | null;
};

type ObserveInput = {
  companyId: string;
  runId: string;
  agentId: string;
  responsibleUserId?: string | null;
  targetIssueId: string;
  targetIssueIdentifier?: string | null;
  kind: CrossIssueInfluenceKind;
  now?: Date;
};

/**
 * Every run-context refusal on this path leaves the same audit row the
 * checkout/release gate writes, so a caller sees one auditable denial contract
 * however it reached the refusal (FAI-9983). Best-effort on purpose: a failed
 * audit insert must not turn a clean 403 back into a 500.
 *
 * Written outside the counter transaction — that transaction rolls back when
 * the denial throws, which would take the audit row with it.
 */
async function auditRunContextDenied(db: Db, input: ObserveInput, denial: RunContextDenial) {
  // Refusing the write is only half the contract: if the run that asked for it
  // is the caller's own live run, it has to finalize as a failure rather than
  // as the silent success FAI-9903 reported. Runs this cannot attribute — spent,
  // forged, another agent's — simply do not match the predicate.
  await recordDurableWriteDenialOnActiveRun(db, {
    runId: input.runId,
    agentId: input.agentId,
    companyId: input.companyId,
  });
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      // The column is a foreign key: only a persisted run id can be stored, so
      // a forged or unknown one is preserved in `details.runId` instead.
      runId: denial.runExists ? agentRunLookupId(input.runId) : null,
      responsibleUserId: input.responsibleUserId ?? null,
      action: "issue.agent_run_context_denied",
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        runId: input.runId,
        runExists: denial.runExists,
        runStatus: denial.runStatus,
        reason: denial.reason,
        kind: input.kind,
        targetIssueId: input.targetIssueId,
        surface: "cross_issue_influence",
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, targetIssueId: input.targetIssueId },
      "Failed to audit denied agent run context",
    );
  }
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 *
 * This lock is released when the counter commits, which is still before the
 * route's durable write. Callers that must not act on a run terminalized in
 * that gap re-lock it inside their own mutation transaction with
 * `lockLiveAgentRun`.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: ObserveInput,
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  const lookupId = agentRunLookupId(input.runId);
  if (!lookupId) {
    await auditRunContextDenied(db, input, { reason: "malformed_run_id", runExists: false, runStatus: null });
    throw crossIssueInfluenceRunContextError();
  }

  const outcome = await db.transaction(async (tx): Promise<
    { denial: RunContextDenial } | { decision: CrossIssueInfluenceDecision | null }
  > => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, lookupId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      return { denial: { reason: "run_not_found", runExists: false, runStatus: null } };
    }
    // Write authority is an allowlist, never "whatever is not terminal": a
    // `scheduled_retry` run is parked with no process behind it and must not be
    // able to speak for the agent (FAI-9983).
    if (!hasAgentWriteRunAuthority(run.status)) {
      return { denial: { reason: "run_not_live", runExists: true, runStatus: run.status } };
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) {
      return { denial: { reason: "run_missing_issue_context", runExists: true, runStatus: run.status } };
    }
    if (
      sourceIssueId === input.targetIssueId ||
      (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
    ) {
      return { decision: null };
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, lookupId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: lookupId,
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
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    return { decision };
  });

  if ("denial" in outcome) {
    await auditRunContextDenied(db, input, outcome.denial);
    throw crossIssueInfluenceRunContextError();
  }
  return outcome.decision;
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
