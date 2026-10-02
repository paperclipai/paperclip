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

/**
 * Which ownership admitted an unscoped run's write, recorded so an audit can tell a
 * charged unscoped write from a scoped run's fan-out.
 *
 * Only `sole_checkout` is uncharged. A run holding several checkouts has no single
 * subject issue, so `shared_checkout` is charged exactly like `assignment`.
 */
export type UnscopedOwnership = "sole_checkout" | "shared_checkout" | "assignment";

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
};

/** The header carrying the caller's heartbeat run, as Express lower-cases it. */
export const RUN_ID_HEADER = "x-paperclip-run-id";

/**
 * Did the caller's `X-Paperclip-Run-Id` header survive the transport and reach us?
 *
 * Presence only. The value is a run id and the denial body is agent-visible, so it is
 * tested here and discarded — never returned, logged, or echoed.
 */
export function runIdHeaderWasSent(req: { header(name: string): string | undefined }): boolean {
  return typeof req.header(RUN_ID_HEADER) === "string";
}

export function crossIssueInfluenceRunContextError(
  options: { runHeaderPresent?: boolean; runResolved?: boolean } = {},
) {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  //
  // `runHeaderPresent` picks between "you never sent it", "it arrived", and — when
  // omitted, because the request is not in hand — a hedge that covers both. Advising a
  // header the caller demonstrably already sent is what sent the probe agent in #12118
  // hunting its own request instead of the transport.
  //
  // `runResolved` then splits "it arrived" in two, because those two failures need
  // opposite advice. A run that resolved but has no issue scope is an ownership
  // problem, and the ownership path is the way out. A run id that resolved to nothing
  // is not: the server never established a run, so it cannot have established who owns
  // the target, and saying so sends the caller to audit permissions it never checked.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
    runHeaderPresent: options.runHeaderPresent,
    runResolved: options.runResolved,
  });
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
  //
  // `runResolved: false`, because no run was established: the copy must point at the
  // run id itself and must not assert anything about who owns the target.
  if (!isUuidLike(input.runId)) {
    throw crossIssueInfluenceRunContextError({ runHeaderPresent: true, runResolved: false });
  }

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
      // The id arrived and is well formed, but it matches no run of this agent in this
      // company — stale, or another agent's. Still not an ownership failure.
      throw crossIssueInfluenceRunContextError({ runHeaderPresent: true, runResolved: false });
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    let unscopedOwnership: UnscopedOwnership | null = null;
    if (!sourceIssueId) {
      // An `on_demand` run has no issue in its snapshot, and nothing the caller sends
      // can supply one. Refusing outright denied an agent writes to its own assigned
      // issues — strictly less than the cap below already grants a *scoped* run, which
      // may reach any visible issue up to `CROSS_ISSUE_INFLUENCE_LIMIT`. So this is not
      // containment to preserve: admit the two ownerships the server can already prove,
      // and keep failing closed for every other target.
      const target = await tx
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(and(
          eq(issues.id, input.targetIssueId),
          eq(issues.companyId, input.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      const holdsCheckout = Boolean(target?.checkoutRunId && target.checkoutRunId === input.runId);
      if (holdsCheckout) {
        // A checkout only stands in for the missing `contextSnapshot.issueId` while it
        // is unambiguous. `POST /issues/:id/checkout` writes one row at a time and does
        // not release the run's other checkouts, so a run can hold several at once — and
        // "whichever one you are writing to is the subject" would hand back the same
        // uncounted fan-out that charging assignment closed. A run has one subject, so
        // the exemption is only for a *sole* checkout.
        const heldCheckouts = await tx
          .select({ count: count() })
          .from(issues)
          .where(and(
            eq(issues.checkoutRunId, input.runId),
            eq(issues.companyId, input.companyId),
          ))
          .then((rows) => Number(rows[0]?.count ?? 0));
        unscopedOwnership = heldCheckouts === 1 ? "sole_checkout" : "shared_checkout";
      } else if (target?.assigneeAgentId && target.assigneeAgentId === input.agentId) {
        // Assignment alone proves permission, not scope. An agent can hold any number of
        // issues, so "the agent is assigned to all of them" bounds nothing.
        unscopedOwnership = "assignment";
      }
      if (!unscopedOwnership) throw crossIssueInfluenceRunContextError({
        runHeaderPresent: true,
        runResolved: true,
      });
      // The run's sole checkout is its subject issue, so writes to it get the same-issue
      // semantics a scoped run's writes to its own source issue get below: uncharged.
      if (unscopedOwnership === "sole_checkout") return null;
      // Every other proven ownership is permitted and charged. Permission and accounting
      // are separate questions, and only permission is what this guard was wrong about:
      // fall through and charge the write like any other cross-issue write.
    }
    if (
      sourceIssueId &&
      (sourceIssueId === input.targetIssueId ||
        (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase()))
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
        // Null on the unscoped path, where there is no source issue to name. The
        // ownership that admitted the write is recorded instead, so an audit can tell
        // a charged unscoped write from a scoped run's fan-out.
        unscopedOwnership,
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
      unscopedOwnership,
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
