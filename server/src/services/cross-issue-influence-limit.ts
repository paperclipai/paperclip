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

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * How the run's source issue was established, for the activity-log trail.
 *
 * `snapshot` is the wake payload. `checkout` is the issue this run holds the
 * checkout/execution lock on — a timer wake writes no `issueId`, so the lock is
 * the only durable record that the run became issue-scoped after it started.
 * `assignee` is the last resort: the run has no source issue at all, but the
 * target is the acting agent's own assigned work.
 */
type RunSourceIssue =
  | { issueId: string; origin: "snapshot" | "checkout" }
  | { issueId: null; origin: "assignee" | "none" };

/**
 * Resolves the issue a run is acting from.
 *
 * A timer/board wake persists `{source:"scheduler", wakeSource:"timer"}` and no
 * issue id, so reading the snapshot alone made the guard fail closed on every
 * write — including an agent disposing of its own assigned issue, which is not
 * a cross-issue write at all. No header can repair that after the fact, because
 * the snapshot is written at wake time. So resolve the run's scope from durable
 * state instead: the checkout lock the run itself took, and failing that, the
 * target issue's assignee.
 */
async function resolveRunSourceIssue(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: { companyId: string; runId: string; agentId: string; targetIssueId: string },
  contextSnapshot: unknown,
): Promise<RunSourceIssue> {
  const fromSnapshot = readRunSourceIssueId(contextSnapshot);
  if (fromSnapshot) return { issueId: fromSnapshot, origin: "snapshot" };

  const locked = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      or(eq(issues.checkoutRunId, input.runId), eq(issues.executionRunId, input.runId)),
    ))
    .then((rows) => rows[0] ?? null);
  if (locked) return { issueId: locked.id, origin: "checkout" };

  const target = await tx
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, input.targetIssueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (target?.assigneeAgentId && target.assigneeAgentId === input.agentId) {
    return { issueId: null, origin: "assignee" };
  }

  return { issueId: null, origin: "none" };
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

    const source = await resolveRunSourceIssue(tx, input, run.contextSnapshot);
    const sourceIssueId = source.issueId;

    // The own-issue passthrough runs BEFORE the fail-closed throw. A run writing
    // to the issue it is scoped to is not influencing another issue, so it must
    // never depend on whether the wake happened to persist a source issue id.
    if (
      sourceIssueId !== null &&
      (sourceIssueId === input.targetIssueId ||
        (input.targetIssueIdentifier &&
          sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase()))
    ) {
      return null;
    }

    // No source issue and the target is not the agent's own work: nothing
    // attributes this write, so it still fails closed.
    if (source.origin === "none") throw crossIssueInfluenceRunContextError();

    // `origin === "assignee"` falls through deliberately. An agent disposing of
    // its own assigned issue from a timer heartbeat is allowed, but it is still
    // metered: the cap is what bounds a runaway sweep across the dozens of
    // issues one agent can own. Permission is restored; the rate backstop is not.

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
        sourceOrigin: source.origin,
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
      sourceOrigin: source.origin,
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
