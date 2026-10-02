import type { Request, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * Read-only run class.
 *
 * An issue in `read_only` work mode produces runs that may read the whole board
 * and report, but never write to it: support for "how is it going?" reports and
 * verification passes that must not be able to mutate the board they inspect.
 *
 * Enforcement lives here and nowhere else: one middleware sits in front of every
 * `/api` route, so a mutating handler cannot forget the check the way a
 * per-route guard can. Read (`GET`/`HEAD`/`OPTIONS`) requests pass untouched.
 *
 * The run's class is derived from the issue the run was dispatched for
 * (`contextSnapshot.issueId`), not from a caller-supplied field: an agent
 * controls its own `X-Paperclip-Run-Id` header, so a self-declared class would
 * be a promise, not a guard.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `read_only` work mode — the run class this guard enforces. */
export const READ_ONLY_WORK_MODE = "read_only";

export type ReadOnlyRunDecision =
  | { denied: false; reason: "not_read_only" | "unknown_run" | "no_run" | "unsafe_identifier" }
  | { denied: true; issueId: string; issueIdentifier: string | null };

function readRunSourceIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) {
    return null;
  }
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function readOnlyRunDenialCode() {
  return "issue_write_read_only_run" as const;
}

/**
 * Resolve whether a run belongs to the read-only class.
 *
 * Fail-open: a run that cannot be resolved (unknown id, missing issue context,
 * non-UUID header) is not a read-only run, and a lookup error is logged and
 * ignored. The guard narrows what a *known* read-only run may do; it is not the
 * authorization boundary, so it must never turn a database hiccup into a board
 * that cannot be written at all.
 */
export async function evaluateReadOnlyRunMutation(
  db: Db,
  input: { companyId: string; runId: string },
): Promise<ReadOnlyRunDecision> {
  if (!isUuidLike(input.companyId) || !isUuidLike(input.runId)) {
    return { denied: false, reason: "unsafe_identifier" };
  }

  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);

  if (!run) return { denied: false, reason: "unknown_run" };

  const issueId = readRunSourceIssueId(run.contextSnapshot);
  if (!issueId || !isUuidLike(issueId)) return { denied: false, reason: "no_run" };

  const issue = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      workMode: issues.workMode,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);

  if (!issue || issue.workMode !== READ_ONLY_WORK_MODE) {
    return { denied: false, reason: "not_read_only" };
  }

  return { denied: true, issueId: issue.id, issueIdentifier: issue.identifier ?? null };
}

/**
 * Reject every mutating request whose run belongs to the read-only class.
 *
 * Only agent-key requests carry a run id; board sessions and routine ingress
 * have no `req.actor.runId` and are never touched by this guard.
 */
export function readOnlyRunGuard(db: Db): RequestHandler {
  return async (req: Request, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
    if (req.actor?.type !== "agent") return next();

    const runId = req.actor.runId;
    const companyId = req.actor.companyId;
    if (!runId || !companyId) return next();

    let decision: ReadOnlyRunDecision;
    try {
      decision = await evaluateReadOnlyRunMutation(db, { companyId, runId });
    } catch (err) {
      logger.warn(
        { err, companyId, runId, method: req.method, path: req.path },
        "read-only run guard lookup failed; allowing the request",
      );
      return next();
    }

    if (!decision.denied) return next();

    const { body } = issueWriteDenialResponse("issue_write_read_only_run", {
      issueIdentifier: decision.issueIdentifier,
    });
    logger.info(
      {
        event: "read_only_run_mutation_denied",
        companyId,
        runId,
        issueId: decision.issueId,
        issueIdentifier: decision.issueIdentifier,
        method: req.method,
        path: req.path,
      },
      "read-only run mutation denied",
    );
    res.status(403).json({
      error: body.error,
      details: {
        ...body.details,
        runId,
        issueId: decision.issueId,
        issueIdentifier: decision.issueIdentifier,
        workMode: READ_ONLY_WORK_MODE,
      },
    });
  };
}
