import { and, count, eq } from "drizzle-orm";
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

/**
 * `runContextRequired` is for a request that arrived with no run at all — the
 * header advice is correct there. `rejected` is for a request that *did* carry a
 * run id which does not resolve to a live run of this agent; the old copy told
 * those callers to resend a header they had already sent.
 */
export function crossIssueInfluenceRunContextError(options: { runIdPresent?: boolean } = {}) {
  const code = options.runIdPresent
    ? "cross_issue_influence_run_context_rejected"
    : "cross_issue_influence_run_context_required";
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse(code);
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

/**
 * A run is in-boundary for an issue it demonstrably holds, even when the wake
 * itself carried no issue scope.
 *
 * This is what unassigned `heartbeat_timer` wakes look like: the run is a
 * company-wide sweep, so `contextSnapshot` legitimately has no `issueId`, but
 * the agent has since checked the target issue out (or an execution is driving
 * it). Refusing those writes stranded every timer-driven run in the company —
 * the checkout succeeded and the disposition could not be recorded.
 *
 * Read without `for update` on purpose: the issue-write routes lock the issue
 * row themselves, and taking that lock here would invert the lock order against
 * `clearCheckoutRunIfTerminal`, which takes issue-then-run. The residual window
 * is bounded and benign: this transaction holds the run row `for update` for its
 * whole body, so a release that goes through `clearCheckoutRunIfTerminal` blocks
 * until this transaction commits, and the write that follows the commit is a
 * single request on an issue the run did hold at decision time.
 *
 * Only a run with a live process holds anything, so the exemption requires
 * `running` rather than merely "not terminal". Both sides of that matter:
 *
 * - A terminal run's claim is released lazily (`clearCheckoutRunIfTerminal`,
 *   `resolveIssueOwner*`), so the column can still name a run that already ended.
 * - A `queued` or `scheduled_retry` run has no process at all, and
 *   `issues.executionRunId` is written at *scheduling* time
 *   (`heartbeat.ts`, the scheduled-retry path), before the run starts. That is a
 *   reservation, not a claim.
 *
 * Without both guards a stale or merely-scheduled id would be a permanent,
 * uncounted exemption — the per-run cap below is the only remaining containment
 * for a write that is not the run's own source issue. A terminal run's own
 * disposition is recorded by finalization, not by a new API write, and a run
 * with no process is not the one making the write, so nothing in-boundary is
 * lost by charging either.
 */
async function runHoldsIssue(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: { companyId: string; runId: string; runStatus: string; targetIssueId: string },
): Promise<boolean> {
  if (input.runStatus !== "running") return false;
  const rows = await tx
    .select({
      issueId: issues.id,
      status: issues.status,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(and(
      eq(issues.id, input.targetIssueId),
      eq(issues.companyId, input.companyId),
    ))
    .then((selected) => selected[0] ?? null);
  if (!rows) return false;
  // A run status check is not enough. Recovery and retry paths can leave a
  // finished issue still referencing a run that is running for other reasons,
  // and exempting that write would hand out uncounted cross-issue influence
  // through a stale terminal binding (Greptile P1 on the claim fallback).
  if (rows.status === "done" || rows.status === "cancelled") return false;
  return rows.checkoutRunId === input.runId || rows.executionRunId === input.runId;
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
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError({ runIdPresent: true });

  return db.transaction(async (tx) => {
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
      throw crossIssueInfluenceRunContextError({ runIdPresent: true });
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (
      sourceIssueId === input.targetIssueId ||
      (input.targetIssueIdentifier && sourceIssueId?.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
    ) {
      return null;
    }

    // A run that holds the target issue is in-boundary regardless of how the
    // wake was scoped. Without this, every unassigned timer wake could check an
    // issue out and then fail to record anything about it.
    if (await runHoldsIssue(tx, { companyId: input.companyId, runId: input.runId, runStatus: run.status, targetIssueId: input.targetIssueId })) {
      return null;
    }

    // No wake-scoped source issue and no live claim: an unassigned run reaching
    // across the company. This is contained by the shared per-run cap below
    // rather than refused outright, so the run can still finish its own work.
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
