import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

/**
 * Agent-authored issue creation gets its own per-run budget, not a share of the 20
 * above.
 *
 * Creates are the highest-amplification write there is — a created issue can be
 * assigned, which wakes an agent, which spawns a run, which can create more issues —
 * and one observed run minted 18 tasks in under six minutes after its comment budget
 * was already spent. But coupling the two budgets has no principled basis and actively breaks
 * correct runs: a planning run that comments fifteen times and then needs to create
 * twenty stage tasks is doing its job, and a shared counter would refuse it halfway.
 * So: a separate counter, a separate rollout, and separate activity actions.
 *
 * The actions must be distinct strings rather than a new `CrossIssueInfluenceKind`,
 * because the tally below filters on `action` alone and never reads `details.kind` —
 * reusing the action would silently fold creates into the shared 20, which is the
 * coupling this separation exists to avoid.
 */
export const ISSUE_CREATE_RUN_LIMIT = 40;
/**
 * Future on purpose: the budget ships in `log_only` so real create volume is measured
 * before anything is refused. Flip by moving this date into the past.
 */
export const ISSUE_CREATE_RUN_ENFORCE_AT = new Date("2026-10-17T00:00:00.000Z");

const ISSUE_CREATE_ACTIVITY = "issue.issue_create_observed";
const ISSUE_CREATE_REJECTED_ACTIVITY = "issue.issue_create_cap_rejected";

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

/**
 * The issue a heartbeat run is scoped to, as this guard reads it.
 *
 * Exported because the per-run issue-create budget below has to ask the same
 * question about a create's intended parent. Two copies of this precedence would let
 * the two guards drift apart.
 */
export function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Does a run's scope name this issue?
 *
 * A `contextSnapshot` may carry either an issue id or a human identifier, so both are
 * accepted — identifiers case-insensitively, since they are stored upper-case but are
 * typed by hand. Extracted from the same-issue check inside
 * `observeCrossIssueInfluence` so the create budget applies the identical predicate to
 * a create's parent.
 */
export function runScopeIsIssue(
  sourceIssueId: string | null,
  issue: { id: string; identifier?: string | null },
): boolean {
  if (!sourceIssueId) return false;
  if (sourceIssueId === issue.id) return true;
  return Boolean(
    issue.identifier && sourceIssueId.toUpperCase() === issue.identifier.toUpperCase(),
  );
}

/**
 * One per-run budget's decision, given its own cap and its own rollout date.
 *
 * Generalised out of `evaluateCrossIssueInfluenceLimit` when creates got a second
 * budget: two copies of "log_only until the flip, then fail closed past the cap" would
 * be two places for the rollout semantics to drift apart.
 */
export function evaluateRunWriteLimit(input: {
  priorCount: number;
  cap: number;
  enforceAt: Date;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= input.enforceAt ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= input.cap,
    mode,
    count: nextCount,
    cap: input.cap,
    enforceAt: input.enforceAt.toISOString(),
  };
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  return evaluateRunWriteLimit({
    ...input,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  });
}

export function evaluateIssueCreateLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  return evaluateRunWriteLimit({
    ...input,
    cap: ISSUE_CREATE_RUN_LIMIT,
    enforceAt: ISSUE_CREATE_RUN_ENFORCE_AT,
  });
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

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) throw crossIssueInfluenceRunContextError();
    if (
      runScopeIsIssue(sourceIssueId, {
        id: input.targetIssueId,
        identifier: input.targetIssueIdentifier ?? null,
      })
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

type IssueCreateLedgerInput = {
  companyId: string;
  runId: string;
  agentId: string;
  responsibleUserId?: string | null;
  parentIssueId?: string | null;
  parentIssueIdentifier?: string | null;
  title?: string | null;
  assigneeAgentId?: string | null;
};

/**
 * One create-ledger row, used for both the charge and the refusal so the two cannot
 * describe the same attempt differently.
 *
 * Keyed on the heartbeat run, not an issue: the charge is taken before the insert, so
 * a refusal mints nothing and there is no issue id to name — and
 * `activity_log.entity_id` is NOT NULL. The counter is per-run anyway, so
 * `activity_log_entity_type_id_idx` yields a run's whole create ledger in one lookup.
 */
function issueCreateLedgerRow(input: IssueCreateLedgerInput & {
  sourceIssueId: string | null;
  decision: CrossIssueInfluenceDecision;
  run?: { responsibleUserId: string | null } | null;
}) {
  return {
    companyId: input.companyId,
    actorType: "agent" as const,
    actorId: input.agentId,
    agentId: input.agentId,
    runId: input.runId,
    responsibleUserId:
      input.responsibleUserId ?? input.run?.responsibleUserId ?? null,
    action: input.decision.allowed
      ? ISSUE_CREATE_ACTIVITY
      : ISSUE_CREATE_REJECTED_ACTIVITY,
    entityType: "heartbeat_run",
    entityId: input.runId,
    details: {
      sourceIssueId: input.sourceIssueId,
      parentIssueId: input.parentIssueId ?? null,
      parentIssueIdentifier: input.parentIssueIdentifier ?? null,
      title: input.title ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      count: input.decision.count,
      cap: input.decision.cap,
      mode: input.decision.mode,
      enforceAt: input.decision.enforceAt,
      allowed: input.decision.allowed,
    },
  };
}

/**
 * Records a refused create, after the transaction that would have inserted the task
 * has already rolled back.
 *
 * Separate from `observeIssueCreate` because the refusal has to outlive that
 * rollback — see the comment at the insert there for why it can be neither inside the
 * transaction nor concurrent with it. Best-effort: losing the audit row must not turn
 * a clean 429 into a 500, so a failure here is logged and swallowed.
 */
export async function recordRefusedIssueCreate(
  db: Db,
  input: IssueCreateLedgerInput & {
    decision: CrossIssueInfluenceDecision;
    sourceIssueId?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(activityLog).values(
      issueCreateLedgerRow({ ...input, sourceIssueId: input.sourceIssueId ?? null }),
    );
  } catch (err) {
    logger.warn(
      {
        err,
        event: "issue_create_cap",
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
      },
      "issue create refusal could not be recorded",
    );
  }
}

/** Thrown by a create-budget guard so the caller can record the refusal and answer 429. */
export class IssueCreateBudgetExceededError extends Error {
  constructor(
    readonly decision: CrossIssueInfluenceDecision,
    readonly sourceIssueId: string | null,
  ) {
    super("Per-run task-creation budget exceeded");
    this.name = "IssueCreateBudgetExceededError";
  }
}

/** The transaction this observer must run in, so its row lock actually holds. */
export type RunWriteTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Observes one agent-authored issue create for a heartbeat run, on the caller's
 * transaction.
 *
 * Takes a transaction rather than a `Db` on purpose, twice over. The run row is
 * locked `FOR UPDATE` so concurrent creates from one run serialize, and that lock is
 * released the moment an implicit single-statement transaction ends — so an observer
 * handed a bare `Db` would look correct and serialize nothing. And the charge has to
 * commit with the task it is charging for: the caller runs this inside the same
 * transaction as the insert, so a refusal (or any later failure) rolls the charge
 * back instead of spending a slot that minted nothing.
 *
 * Returns `null` when the create is not chargeable at all.
 *
 * Two differences from the cross-issue counter are deliberate:
 *
 * 1. **The free write is the parent, not the target.** A create has no target issue
 *    yet; what it has is an intended parent. A create under the run's own source issue
 *    is decomposition of the run's own subject, so it is uncharged exactly as a
 *    same-issue comment is, so a planning run can decompose its own epic without
 *    bound. Parentless and foreign-parent creates are charged. An unscoped
 *    (`on_demand`) run has no source issue, so it has no free parent and every one of
 *    its creates is charged.
 * 2. **An unusable run id does not refuse the create.** The cross-issue guard throws a
 *    403 here, but creates were never gated at all before this counter, so turning an
 *    uncountable create into a refusal would newly break agents that are entitled to
 *    create. This counter's job is to count; a create it cannot attribute to a run is
 *    logged and allowed through.
 */
export async function observeIssueCreate(
  tx: RunWriteTransaction,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    /** The create's intended parent, or null for a root issue. */
    parentIssueId?: string | null;
    parentIssueIdentifier?: string | null;
    title?: string | null;
    assigneeAgentId?: string | null;
    now?: Date;
  },
): Promise<(CrossIssueInfluenceDecision & { sourceIssueId: string | null }) | null> {
  // API-key callers control the run header, so a malformed value must never reach a
  // PostgreSQL uuid cast. Unlike the cross-issue guard this is not a denial — see (2).
  if (!isUuidLike(input.runId)) {
    logger.warn(
      { event: "issue_create_cap", companyId: input.companyId, agentId: input.agentId },
      "issue create not counted: run id is not a usable identifier",
    );
    return null;
  }

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
  if (!run) {
    // Well formed, but no run of this agent in this company — stale or another
    // agent's. Nothing to charge it to, and refusing is not this counter's call.
    logger.warn(
      {
        event: "issue_create_cap",
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
      },
      "issue create not counted: run id matched no run of this agent",
    );
    return null;
  }

  const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
  if (
    input.parentIssueId &&
    runScopeIsIssue(sourceIssueId, {
      id: input.parentIssueId,
      identifier: input.parentIssueIdentifier ?? null,
    })
  ) {
    // Decomposition under the epic this run owns. Unbounded by design.
    return null;
  }

  const priorCount = await tx
    .select({ count: count() })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.runId, input.runId),
      eq(activityLog.action, ISSUE_CREATE_ACTIVITY),
    ))
    .then((rows) => Number(rows[0]?.count ?? 0));
  const decision = evaluateIssueCreateLimit({ priorCount, now: input.now });

  // Only the charge goes in the caller's transaction. A refusal must not: the caller
  // refuses by throwing, the throw rolls this transaction back, and a refusal row
  // written here would roll back with it — leaving nothing but a log line. It cannot
  // be written from a second connection either, because `activity_log.run_id`
  // references `heartbeat_runs` and that foreign key needs `FOR KEY SHARE` on the row
  // this transaction still holds `FOR UPDATE`. So the caller records refusals through
  // `recordRefusedIssueCreate` once its transaction is gone.
  if (decision.allowed) {
    await tx.insert(activityLog).values(
      issueCreateLedgerRow({ ...input, sourceIssueId, decision, run }),
    );
  }

  const logContext = {
    event: "issue_create_cap",
    companyId: input.companyId,
    runId: input.runId,
    agentId: input.agentId,
    sourceIssueId,
    parentIssueId: input.parentIssueId ?? null,
    count: decision.count,
    cap: decision.cap,
    mode: decision.mode,
    enforceAt: decision.enforceAt,
    allowed: decision.allowed,
  };
  if (decision.allowed) {
    logger.info(logContext, "issue create observed");
  } else {
    logger.warn(logContext, "issue create cap exceeded");
  }

  // `sourceIssueId` rides along so a caller recording the refusal after its rollback
  // describes the same attempt the charge would have, without re-reading the run row.
  return { ...decision, sourceIssueId };
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

export function issueCreateLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null } = {},
) {
  // Same contract as the cross-issue cap's 429, and deliberately a *different* code:
  // an agent told "20 cross-issue writes" after a refused create would go auditing a
  // boundary that did not fire.
  const { body } = issueWriteDenialResponse("issue_create_cap_exceeded", {
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
