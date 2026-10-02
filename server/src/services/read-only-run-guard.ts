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
 * and report, but never write to it. This is a server-side boundary: a caller
 * cannot opt out by omitting or substituting its run id.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `read_only` work mode — the run class this guard enforces. */
export const READ_ONLY_WORK_MODE = "read_only";

type ReadOnlyRunAllowReason = "not_read_only" | "unknown_run" | "no_run" | "unsafe_identifier";
export type ReadOnlyRunDecision =
  | { denied: false; reason: ReadOnlyRunAllowReason }
  | {
      denied: true;
      reason: "read_only" | "run_identity_required";
      issueId: string | null;
      issueIdentifier: string | null;
    };

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
 * Resolve whether a verified active agent run belongs to the read-only class.
 *
 * A persistent agent API key is not a run credential. For a mutation it must
 * therefore carry an active run id that belongs to that same agent. Otherwise a
 * read-only runner could simply omit the header or borrow another run id. A
 * signed agent JWT already binds its subject and run id in auth middleware, but
 * it is still checked against the run row here so a completed run cannot write.
 */
export async function evaluateReadOnlyRunMutation(
  db: Db,
  input: { companyId: string; agentId: string; runId: string | null | undefined },
): Promise<ReadOnlyRunDecision> {
  if (!input.runId || !isUuidLike(input.companyId) || !isUuidLike(input.agentId) || !isUuidLike(input.runId)) {
    return { denied: true, reason: "run_identity_required", issueId: null, issueIdentifier: null };
  }

  const run = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);

  // Fail closed for a mutating agent request: an unknown, foreign, or completed
  // run is not evidence that this request was made by the current execution.
  if (!run || run.agentId !== input.agentId || run.status !== "running") {
    return { denied: true, reason: "run_identity_required", issueId: null, issueIdentifier: null };
  }

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

  return {
    denied: true,
    reason: "read_only",
    issueId: issue.id,
    issueIdentifier: issue.identifier ?? null,
  };
}

/** Reject every mutating request whose agent run is unverified or read-only. */
export function readOnlyRunGuard(db: Db): RequestHandler {
  return async (req: Request, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
    if (req.actor?.type !== "agent") return next();

    const { agentId, companyId, runId } = req.actor;
    if (!companyId || !agentId) return next();

    let decision: ReadOnlyRunDecision;
    try {
      decision = await evaluateReadOnlyRunMutation(db, { companyId, agentId, runId });
    } catch (err) {
      // A transient failed lookup is not proof of a writable run. Do not let a
      // recovered route query turn a read-only execution into a board write.
      logger.warn(
        { err, companyId, agentId, runId, method: req.method, path: req.path },
        "read-only run guard lookup failed; denying the mutation",
      );
      decision = { denied: true, reason: "run_identity_required", issueId: null, issueIdentifier: null };
    }

    if (!decision.denied) return next();

    const denialCode = decision.reason === "read_only"
      ? "issue_write_read_only_run"
      : "issue_write_run_identity_required";
    const { body } = issueWriteDenialResponse(denialCode, {
      issueIdentifier: decision.issueIdentifier,
    });
    logger.info(
      {
        event: "read_only_run_mutation_denied",
        reason: decision.reason,
        companyId,
        agentId,
        runId: runId ?? null,
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
        runId: runId ?? null,
        issueId: decision.issueId,
        issueIdentifier: decision.issueIdentifier,
        workMode: decision.reason === "read_only" ? READ_ONLY_WORK_MODE : null,
      },
    });
  };
}
