import { and, count, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

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

type RunBinding = { id: string; checkoutRunId?: string | null; executionRunId?: string | null };

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function bindingHoldsRun(binding: RunBinding | null | undefined, runId: string) {
  if (!binding) return false;
  return binding.checkoutRunId === runId || binding.executionRunId === runId;
}

/**
 * True when the server itself bound this run to the issue being written.
 *
 * `checkout` is the platform's own run-to-issue binding and it writes
 * `issues.checkoutRunId` / `issues.executionRunId`, not the run's context
 * snapshot. The binding is server-written, so a mismatch means this run never
 * checked the issue out — attribution must never be borrowed from whoever
 * happens to hold the lock.
 */
export function runOwnsIssueBinding(
  binding: RunBinding | null | undefined,
  runId: string,
  targetIssueId: string,
): boolean {
  return !!binding && binding.id === targetIssueId && bindingHoldsRun(binding, runId);
}

/**
 * Attributes a cross-issue write to the run's own checked-out issue.
 *
 * A timer or on-demand run is dispatched with no source issue, so the run's
 * context snapshot names none and the guard used to refuse every comment and
 * update — including writes to the agent's own board work, which is not
 * cross-issue influence. Before this, the fallback asked the *target* issue
 * whether it was bound to the run, so a run that had checked out task X was
 * refused for writing to task Y. That made the guard's own recovery guidance
 * (the 403 tells the agent to check a task out) cost a checkout and change
 * nothing, and it left the platform unable to un-block an issue by status.
 *
 * The source is now the issue the run actually checked out, and the per-source
 * counter is attributed to it. The genuine unattributable case — a run bound to
 * no issue at all — is still refused, which is the case the cap protects
 * against.
 *
 * The query reads only server-written columns, so attribution cannot be forged
 * by a client. Neither `checkout_run_id` nor `execution_run_id` is unique —
 * `execution_run_id` is also written by wake-queue dispatch — so a run can hold
 * more than one, and the rows are ordered to pick a *stable* one instead of an
 * arbitrary one. Picking by recency would be wrong on purpose: the latest lock
 * may be the run's own current work, and the ordering only exists to make the
 * same run and board produce the same sourceIssueId on every write.
 */
async function resolveRunCheckoutSourceIssueId(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: { companyId: string; runId: string; targetIssueId: string },
): Promise<string | null> {
  const rows = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      or(
        eq(issues.checkoutRunId, input.runId),
        eq(issues.executionRunId, input.runId),
      ),
    ))
    .orderBy(issues.id)
    .limit(1)
    .then((found) => found[0]?.id ?? null);
  return rows;
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
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  return db.transaction(async (tx) => {
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

    const snapshotSourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    // A checkout, not the snapshot, is the run-to-issue binding the 403 tells
    // the agent to establish — so the source has to be the issue the run checked
    // out, never the issue being written. Anything checked out wins, because a
    // run bound to task X writing to X is not cross-issue influence at all and
    // must not spend the cross-issue budget.
    const checkoutSourceIssueId = await resolveRunCheckoutSourceIssueId(tx, {
      companyId: input.companyId,
      runId: input.runId,
      targetIssueId: input.targetIssueId,
    });
    const sourceIssueId = checkoutSourceIssueId ?? snapshotSourceIssueId;
    if (!sourceIssueId) throw crossIssueInfluenceRunContextError();
    if (
      sourceIssueId === input.targetIssueId ||
      (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
    ) {
      return null;
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

    return decision;
  });
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
