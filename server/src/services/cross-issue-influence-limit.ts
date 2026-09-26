import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  isUuidLike,
  issueWriteDenialResponse,
  type CrossIssueRunContextReason,
  type IssueWriteDenialContext,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
 * Refuse a write the run-context gate cannot attribute.
 *
 * The reason is a required argument, not an afterthought: the three conditions
 * have three different remedies, and the copy has to be told which one fired.
 * Before this took a reason, every refusal shipped "send `X-Paperclip-Run-Id`
 * and retry" — including the one condition where the run id was already proven
 * present, which made the error path impossible to satisfy and read to an
 * operator as "this write cannot be done".
 */
export function crossIssueInfluenceRunContextError(
  reason: CrossIssueRunContextReason,
  context: IssueWriteDenialContext = {},
) {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
    ...context,
    reason,
  });
  // `reason` is surfaced verbatim, next to `code`, so a JSON consumer branches
  // on the machine value instead of parsing the prose.
  return forbidden(body.error, {
    ...body.details,
    reason,
    targetOwnedByAnotherAgent: context.targetOwnedByAnotherAgent === true,
  });
}

/**
 * Best-effort owner of the target issue, read only on the refusal path.
 *
 * The copy must distinguish "this run could not be identified" from "this run
 * is identified and the task simply belongs to someone else", because the fix
 * differs: one needs the run header, the other needs a child issue or a
 * reassignment. A denial is rare, so one extra query buys a rejection that
 * names who actually holds the task. Any failure degrades to the generic nouns
 * rather than masking the refusal.
 */
async function readTargetOwnership(
  tx: DbTransaction,
  input: {
    companyId: string;
    targetIssueId: string;
    agentId: string;
    targetIssueIdentifier?: string | null;
  },
) {
  const fallback = {
    identifier: input.targetIssueIdentifier ?? null,
    assigneeName: null as string | null,
    ownedByAnotherAgent: false,
  };
  try {
    const rows = await tx
      .select({
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeName: agents.name,
      })
      .from(issues)
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(and(
        eq(issues.id, input.targetIssueId),
        eq(issues.companyId, input.companyId),
      ));
    const target = rows[0];
    if (!target) return fallback;
    return {
      identifier: target.identifier ?? fallback.identifier,
      assigneeName: target.assigneeName ?? null,
      ownedByAnotherAgent:
        Boolean(target.assigneeAgentId) && target.assigneeAgentId !== input.agentId,
    };
  } catch (err) {
    logger.warn(
      { err, targetIssueId: input.targetIssueId },
      "failed to resolve target ownership for run-context denial copy",
    );
    return fallback;
  }
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
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError("malformed_run_id");

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
      throw crossIssueInfluenceRunContextError("run_not_found");
    }

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) {
      // Reached only after the run resolved, company-matched and agent-matched,
      // so the run id is already carried and proven good. The missing half is
      // the target binding, and the copy has to say exactly that: the header
      // advice that used to ship here was advice this branch's own earlier
      // checks had already disproved.
      const target = await readTargetOwnership(tx, input);
      throw crossIssueInfluenceRunContextError(
        "no_context_source_and_target_unbound",
        {
          issueIdentifier: target.identifier,
          assigneeLabel: target.assigneeName,
          targetOwnedByAnotherAgent: target.ownedByAnotherAgent,
        },
      );
    }
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
