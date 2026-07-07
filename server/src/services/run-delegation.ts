import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  DELEGATION_CHILD_COMPLETED_WAKE_REASON,
  DELEGATION_MAX_CHILDREN_PER_RUN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_WAIT_TIMEOUT_MAX_SEC,
  delegationStatusToA2ATaskState,
  type DelegateRunInput,
  type DelegationStatus,
  type HeartbeatRunStatus,
} from "@paperclipai/shared";
import { forbidden, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { evaluateAgentInvokabilityFromDb, type AgentOrgRow } from "./agent-invokability.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";

/**
 * Parent statuses that still deserve a `delegation_child_completed` wake once
 * the child finishes. `succeeded` covers the documented wait:false contract
 * (delegate, exit, get woken with the result). `timed_out` is included so a
 * parent that died waiting does not waste the child's completed work.
 * `cancelled` is deliberately excluded: cancellation is operator intent.
 */
const CONTINUATION_ELIGIBLE_PARENT_STATUSES = new Set<HeartbeatRunStatus>([
  "succeeded",
  "timed_out",
]);

const TERMINAL_RUN_STATUSES = new Set<HeartbeatRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const CANCELLABLE_CHILD_STATUSES: HeartbeatRunStatus[] = [
  "queued",
  "scheduled_retry",
  "running",
];

/** Fallback DB poll interval while waiting for a child run (event notification is the primary path). */
const WAIT_FALLBACK_POLL_MS = 10_000;

export type EnqueueWakeupFn = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<{ id: string; status: string } | null>;

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status as HeartbeatRunStatus);
}

export function isReportOf(
  managerId: string,
  reportAgentId: string,
  lookup: (id: string) => Pick<AgentOrgRow, "reportsTo"> | null,
): boolean {
  if (managerId === reportAgentId) return false;
  let cursor: string | null = reportAgentId;
  const seen = new Set<string>();
  while (cursor) {
    const row = lookup(cursor);
    if (!row) return false;
    if (row.reportsTo === managerId) return true;
    if (!row.reportsTo || seen.has(row.reportsTo)) return false;
    seen.add(row.reportsTo);
    cursor = row.reportsTo;
  }
  return false;
}

/** Delegation depth for a child spawned by a run with the given context (OpenCode-style level limit). */
export function nextDelegationDepth(parentContext: Record<string, unknown> | null | undefined): number {
  const raw = parentContext?.delegationDepth;
  const parentDepth = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  return parentDepth + 1;
}

function buildDelegationResult(child: HeartbeatRunRow) {
  const resultJson = child.resultJson && typeof child.resultJson === "object" ? child.resultJson : {};
  const summary =
    readNonEmptyString(child.nextAction) ??
    readNonEmptyString((resultJson as Record<string, unknown>).summary) ??
    readNonEmptyString((resultJson as Record<string, unknown>).message) ??
    readNonEmptyString(child.livenessReason) ??
    null;
  return {
    childRunId: child.id,
    childStatus: child.status,
    summary,
    resultJson,
    error: child.error,
    errorCode: child.errorCode,
  };
}

function delegationStatusFromChild(child: HeartbeatRunRow): DelegationStatus {
  if (child.status === "succeeded") return "completed";
  if (child.status === "cancelled") return "cancelled";
  return "failed";
}

export function runDelegationService(
  db: Db,
  deps: {
    enqueueWakeup: EnqueueWakeupFn;
    getRun: (runId: string) => Promise<HeartbeatRunRow | null>;
    cancelRun: (runId: string, reason?: string) => Promise<HeartbeatRunRow | null>;
  },
) {
  const issuesSvc = issueService(db);

  /**
   * In-process waiters keyed by child run id. `notifyChildRunTerminal` resolves
   * them the moment the heartbeat finalize/cancel path reports the child as
   * terminal, so `wait: true` does not need tight DB polling. A slow fallback
   * poll (10s) covers any missed notification.
   */
  const childRunWaiters = new Map<string, Set<(run: HeartbeatRunRow) => void>>();

  function notifyChildRunTerminal(run: HeartbeatRunRow) {
    const waiters = childRunWaiters.get(run.id);
    if (!waiters) return;
    childRunWaiters.delete(run.id);
    for (const resolve of waiters) {
      try {
        resolve(run);
      } catch (err) {
        logger.warn({ err, runId: run.id }, "delegation waiter callback failed");
      }
    }
  }

  async function waitForChildTerminal(childRunId: string, timeoutMs: number): Promise<HeartbeatRunRow | null> {
    const initial = await deps.getRun(childRunId);
    if (!initial || isTerminalRunStatus(initial.status)) return initial;

    return new Promise<HeartbeatRunRow | null>((resolve) => {
      let settled = false;
      let fallbackTimer: NodeJS.Timeout | null = null;
      let deadlineTimer: NodeJS.Timeout | null = null;

      const settle = (run: HeartbeatRunRow | null) => {
        if (settled) return;
        settled = true;
        if (fallbackTimer) clearInterval(fallbackTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        const waiters = childRunWaiters.get(childRunId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) childRunWaiters.delete(childRunId);
        }
        resolve(run);
      };

      const waiter = (run: HeartbeatRunRow) => settle(run);
      const existing = childRunWaiters.get(childRunId);
      if (existing) existing.add(waiter);
      else childRunWaiters.set(childRunId, new Set([waiter]));

      fallbackTimer = setInterval(() => {
        void deps.getRun(childRunId)
          .then((run) => {
            if (run && isTerminalRunStatus(run.status)) settle(run);
            if (!run) settle(null);
          })
          .catch((err) => logger.warn({ err, childRunId }, "delegation wait fallback poll failed"));
      }, WAIT_FALLBACK_POLL_MS);

      deadlineTimer = setTimeout(() => {
        void deps.getRun(childRunId)
          .then((run) => settle(run))
          .catch(() => settle(null));
      }, timeoutMs);
    });
  }

  async function getAgentOrgRow(agentId: string): Promise<AgentOrgRow | null> {
    const [row] = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row ?? null;
  }

  async function loadAgentLookup(companyId: string) {
    const rows = await db
      .select({
        id: agents.id,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (id: string) => byId.get(id) ?? null;
  }

  async function resolveIssueId(companyId: string, issueRef: string | null | undefined, parentContext: Record<string, unknown>) {
    const fromInput = readNonEmptyString(issueRef);
    const fromContext =
      readNonEmptyString(parentContext.issueId) ?? readNonEmptyString(parentContext.taskId);
    const candidate = fromInput ?? fromContext;
    if (!candidate) return null;

    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, candidate)))
      .limit(1);
    if (issue) return issue.id;

    const [byIdentifier] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.identifier, candidate.toUpperCase())))
      .limit(1);
    return byIdentifier?.id ?? null;
  }

  async function createDelegationChildIssue(input: {
    companyId: string;
    parentIssueId: string;
    targetAgentId: string;
    title: string;
    description: string;
    sourceRunId: string;
    sourceAgentId: string;
  }) {
    const parent = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        requestDepth: issues.requestDepth,
      })
      .from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.companyId, input.companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!parent) return null;

    const child = await issuesSvc.create(input.companyId, {
      title: input.title,
      description: input.description,
      parentId: parent.id,
      projectId: parent.projectId,
      goalId: parent.goalId,
      assigneeAgentId: input.targetAgentId,
      status: "todo",
      inheritExecutionWorkspaceFromIssueId: parent.id,
    });
    return child.id;
  }

  async function countChildDelegations(parentRunId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.parentRunId, parentRunId));
    return row?.count ?? 0;
  }

  async function delegateFromRun(
    parentRunId: string,
    sourceAgentId: string,
    input: DelegateRunInput,
  ) {
    const parent = await deps.getRun(parentRunId);
    if (!parent) throw notFound("Heartbeat run not found");
    if (parent.agentId !== sourceAgentId) {
      throw forbidden("Only the run owner can delegate from this run");
    }
    if (parent.status !== "running") {
      throw conflict("Delegation requires an active running heartbeat", { status: parent.status });
    }
    if (parent.delegationStatus === "pending") {
      throw conflict("A delegation is already pending for this heartbeat run", {
        delegationResultJson: parent.delegationResultJson ?? null,
      });
    }

    const parentContext = (parent.contextSnapshot ?? {}) as Record<string, unknown>;

    const childDepth = nextDelegationDepth(parentContext);
    if (childDepth > DELEGATION_MAX_DEPTH) {
      throw conflict(
        `Delegation depth limit reached (max ${DELEGATION_MAX_DEPTH}); complete this work directly or restructure via child issues`,
        { delegationDepth: childDepth, maxDepth: DELEGATION_MAX_DEPTH },
      );
    }

    const existingChildren = await countChildDelegations(parentRunId);
    if (existingChildren >= DELEGATION_MAX_CHILDREN_PER_RUN) {
      throw conflict(
        `Delegation budget exhausted for this run (max ${DELEGATION_MAX_CHILDREN_PER_RUN} children)`,
        { childCount: existingChildren, maxChildren: DELEGATION_MAX_CHILDREN_PER_RUN },
      );
    }

    const waitTimeoutSec = Math.min(input.waitTimeoutSec, DELEGATION_WAIT_TIMEOUT_MAX_SEC);

    const sourceAgent = await getAgentOrgRow(sourceAgentId);
    const targetAgent = await getAgentOrgRow(input.targetAgentId);
    if (!sourceAgent || !targetAgent) throw notFound("Agent not found");
    if (sourceAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Cross-company delegation is not allowed");
    }

    const lookup = await loadAgentLookup(sourceAgent.companyId);
    if (!isReportOf(sourceAgent.id, targetAgent.id, lookup)) {
      throw forbidden("Target agent must report to the delegating agent in the org chart");
    }

    const targetInvokability = await evaluateAgentInvokabilityFromDb(db, targetAgent);
    if (!targetInvokability.invokable) {
      throw conflict(targetInvokability.message, {
        reason: targetInvokability.reason,
        invalidOrgChain: targetInvokability.invalidOrgChain,
      });
    }

    const parentIssueId = await resolveIssueId(sourceAgent.companyId, input.issueId, parentContext);

    let childIssueId: string | null = null;
    if (input.createChildIssue && parentIssueId) {
      childIssueId = await createDelegationChildIssue({
        companyId: sourceAgent.companyId,
        parentIssueId,
        targetAgentId: targetAgent.id,
        title: input.childIssueTitle?.trim() || `Delegated: ${input.task.slice(0, 120)}`,
        description: [
          "## A2A delegation",
          `From: ${sourceAgent.name} (${sourceAgent.id})`,
          `Parent run: ${parentRunId}`,
          "",
          input.task,
        ].join("\n"),
        sourceRunId: parentRunId,
        sourceAgentId: sourceAgent.id,
      });
    }

    const delegationIssueId = childIssueId ?? parentIssueId;
    const idempotencyKey = `delegate:${parentRunId}:${targetAgent.id}:${delegationIssueId ?? "no-issue"}:${existingChildren}`;

    const childRun = await deps.enqueueWakeup(targetAgent.id, {
      source: "automation",
      triggerDetail: "system",
      reason: "a2a_delegate",
      idempotencyKey,
      requestedByActorType: "agent",
      requestedByActorId: sourceAgent.id,
      payload: {
        issueId: delegationIssueId,
        taskId: delegationIssueId,
        paperclipSessionHandoffMarkdown: [
          "## A2A delegation (Paperclip)",
          `From agent: ${sourceAgent.name}`,
          `Parent run: ${parentRunId}`,
          delegationIssueId ? `Issue: ${delegationIssueId}` : null,
          "",
          input.task,
        ].filter(Boolean).join("\n"),
      },
      contextSnapshot: {
        issueId: delegationIssueId,
        taskId: delegationIssueId,
        wakeReason: "a2a_delegate",
        wakeSource: "automation",
        delegatedFromRunId: parentRunId,
        delegatedFromAgentId: sourceAgent.id,
        delegationTask: input.task,
        delegationDepth: childDepth,
        parentIssueId,
        childIssueId,
      },
    });

    if (!childRun) {
      throw conflict("Failed to enqueue delegated agent wakeup");
    }

    try {
      await db
        .update(heartbeatRuns)
        .set({
          parentRunId: parentRunId,
          delegationStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, childRun.id));

      await db
        .update(heartbeatRuns)
        .set({
          livenessState: "awaiting_delegation",
          livenessReason: `Delegated to ${targetAgent.name}`,
          delegationStatus: "pending",
          delegationResultJson: {
            childRunId: childRun.id,
            childAgentId: targetAgent.id,
            childAgentName: targetAgent.name,
            childIssueId,
            delegationDepth: childDepth,
            task: input.task,
          },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, parentRunId));
    } catch (err) {
      // Compensation: never leave an orphan child running when parent-side
      // bookkeeping failed — the parent would have no record of the delegation.
      await deps.cancelRun(childRun.id, "Delegation bookkeeping failed; compensating cancel").catch((cancelErr) => {
        logger.error({ err: cancelErr, childRunId: childRun.id }, "delegation compensation cancel failed");
      });
      throw err;
    }

    await logActivity(db, {
      companyId: sourceAgent.companyId,
      actorType: "agent",
      actorId: sourceAgent.id,
      agentId: sourceAgent.id,
      runId: parentRunId,
      action: "heartbeat.delegation.enqueued",
      entityType: "heartbeat_run",
      entityId: childRun.id,
      details: {
        parentRunId,
        targetAgentId: targetAgent.id,
        childIssueId,
        delegationDepth: childDepth,
        wait: input.wait,
      },
    });

    if (!input.wait) {
      return {
        parentRunId,
        childRunId: childRun.id,
        childIssueId,
        delegationStatus: "pending" as const,
        a2aTaskState: delegationStatusToA2ATaskState("pending"),
        wait: false,
      };
    }

    const latestChild = await waitForChildTerminal(childRun.id, waitTimeoutSec * 1000);
    if (!latestChild) throw notFound("Delegated child run not found");

    if (!isTerminalRunStatus(latestChild.status)) {
      return {
        parentRunId,
        childRunId: childRun.id,
        childIssueId,
        delegationStatus: "pending" as const,
        a2aTaskState: delegationStatusToA2ATaskState("pending"),
        wait: true,
        timedOut: true,
        recoveryHint: `Child run still active; poll GET /api/heartbeat-runs/${parentRunId}/delegation for the result`,
        childRun: {
          id: latestChild.id,
          status: latestChild.status,
        },
      };
    }

    const delegationResult = buildDelegationResult(latestChild);
    const delegationStatus = delegationStatusFromChild(latestChild);
    await finalizeParentDelegation(parentRunId, latestChild, delegationStatus, delegationResult, {
      enqueueParentContinuation: false,
    });

    return {
      parentRunId,
      childRunId: childRun.id,
      childIssueId,
      delegationStatus,
      a2aTaskState: delegationStatusToA2ATaskState(delegationStatus),
      wait: true,
      timedOut: false,
      childRun: {
        id: latestChild.id,
        status: latestChild.status,
        resultJson: latestChild.resultJson,
      },
      delegationResult,
    };
  }

  /**
   * Compare-and-set finalize: only the caller that transitions the parent's
   * `delegationStatus` away from `pending` performs side effects (continuation
   * wake). This makes the wait:true HTTP loop and the heartbeat finalize path
   * race-safe when both observe the child completing.
   */
  async function finalizeParentDelegation(
    parentRunId: string,
    childRun: HeartbeatRunRow,
    delegationStatus: DelegationStatus,
    delegationResult: ReturnType<typeof buildDelegationResult>,
    options: { enqueueParentContinuation: boolean },
  ) {
    const updatedParent = await db
      .update(heartbeatRuns)
      .set({
        delegationStatus,
        delegationResultJson: delegationResult as unknown as Record<string, unknown>,
        ...(delegationStatus === "completed" ? { livenessState: "advanced" } : {}),
        ...(delegationStatus === "failed" || delegationStatus === "cancelled"
          ? { livenessState: "needs_followup" }
          : {}),
        livenessReason:
          delegationStatus === "completed"
            ? `Delegation to child run ${childRun.id} completed`
            : delegationStatus === "cancelled"
              ? `Delegation to child run ${childRun.id} was cancelled`
              : `Delegation child run ${childRun.id} ended with ${childRun.status}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, parentRunId),
          eq(heartbeatRuns.delegationStatus, "pending"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus,
        delegationResultJson: delegationResult as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, childRun.id));

    // Lost the CAS (another path already finalized) — no side effects.
    if (!updatedParent) return;

    if (!options.enqueueParentContinuation) return;
    if (!CONTINUATION_ELIGIBLE_PARENT_STATUSES.has(updatedParent.status as HeartbeatRunStatus)) return;

    const parentContext = updatedParent.contextSnapshot as Record<string, unknown> | null;
    await deps.enqueueWakeup(updatedParent.agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
      requestedByActorType: "system",
      requestedByActorId: "run_delegation",
      idempotencyKey: `delegation-complete:${parentRunId}:${childRun.id}`,
      contextSnapshot: {
        issueId: readNonEmptyString(parentContext?.issueId),
        taskId: readNonEmptyString(parentContext?.taskId),
        wakeReason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
        delegatedChildRunId: childRun.id,
        delegationResult,
        delegationDepth: typeof parentContext?.delegationDepth === "number" ? parentContext.delegationDepth : 0,
        delegationParentRunId: parentRunId,
      },
      payload: {
        delegationResult,
        parentRunId,
        childRunId: childRun.id,
      },
    });
  }

  /** CAS abort: only flips `pending` → `cancelled`; returns whether a row changed. */
  async function abortParentDelegationState(parentRunId: string, reason: string): Promise<boolean> {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        delegationStatus: "cancelled",
        livenessState: "needs_followup",
        livenessReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, parentRunId),
          eq(heartbeatRuns.delegationStatus, "pending"),
        ),
      )
      .returning({ id: heartbeatRuns.id });
    return updated.length > 0;
  }

  /**
   * Called from every child-terminal path in the heartbeat (success, failure,
   * cancellation). Resolves in-process waiters first so `wait: true` callers
   * return immediately, then settles the parent's delegation state.
   */
  async function handleChildRunCompleted(childRun: HeartbeatRunRow) {
    if (!childRun.parentRunId) return;
    notifyChildRunTerminal(childRun);

    const parent = await deps.getRun(childRun.parentRunId);
    if (!parent || parent.delegationStatus !== "pending") return;
    if (parent.status === "cancelled") {
      await abortParentDelegationState(parent.id, `Parent run cancelled before child ${childRun.id} completed`);
      return;
    }

    const delegationResult = buildDelegationResult(childRun);
    const delegationStatus = delegationStatusFromChild(childRun);
    await finalizeParentDelegation(childRun.parentRunId, childRun, delegationStatus, delegationResult, {
      enqueueParentContinuation: true,
    });

    await logActivity(db, {
      companyId: childRun.companyId,
      actorType: "system",
      actorId: "run_delegation",
      agentId: parent.agentId,
      runId: parent.id,
      action: "heartbeat.delegation.completed",
      entityType: "heartbeat_run",
      entityId: childRun.id,
      details: {
        parentRunId: parent.id,
        delegationStatus,
      },
    });
  }

  async function cancelChildDelegations(parentRunId: string, reason: string) {
    const children = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.parentRunId, parentRunId),
          inArray(heartbeatRuns.status, CANCELLABLE_CHILD_STATUSES),
        ),
      );

    for (const child of children) {
      const cancelled = await deps.cancelRun(child.id, reason).catch((err) => {
        logger.warn({ err, childRunId: child.id, parentRunId }, "failed to cancel delegated child run");
        return null;
      });
      await db
        .update(heartbeatRuns)
        .set({
          delegationStatus: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, child.id));
      if (cancelled) notifyChildRunTerminal(cancelled);
    }
    await abortParentDelegationState(parentRunId, reason);
  }

  /**
   * Safety net for terminal paths that bypass the direct hooks (recovery
   * timeouts, server restarts mid-delegation, crashed finalizers). Settles any
   * parent stuck in `delegationStatus: pending` whose children have all
   * reached a terminal status. Called from the heartbeat timer tick; the
   * partial index on pending delegations keeps this query cheap.
   */
  async function sweepStalePendingDelegations() {
    const pendingRows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        parentRunId: heartbeatRuns.parentRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.delegationStatus, "pending"))
      .limit(50);

    let settled = 0;
    for (const row of pendingRows) {
      // Re-read: earlier iterations may have already settled this row
      // (parent settle also updates its child mirror).
      const current = await deps.getRun(row.id);
      if (!current || current.delegationStatus !== "pending") continue;

      const children = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.parentRunId, row.id))
        .orderBy(heartbeatRuns.createdAt);

      if (children.length > 0) {
        // Row is a delegating parent (possibly mid-chain). Settle it once its
        // latest child is terminal.
        const lastChild = children[children.length - 1]!;
        if (!isTerminalRunStatus(lastChild.status)) continue;
        await handleChildRunCompleted(lastChild);
        settled += 1;
        continue;
      }

      if (row.parentRunId) {
        // Pure child mirror row: settled by its parent's sweep entry when the
        // child is terminal; a still-running child is healthy, skip.
        if (!isTerminalRunStatus(row.status)) continue;
        const childRow = await deps.getRun(row.id);
        if (childRow) {
          await handleChildRunCompleted(childRow);
          settled += 1;
        }
        continue;
      }

      // Pending flag with no children and no parent: bookkeeping failed
      // mid-delegate; repair so the run does not stay pending forever.
      const changed = await abortParentDelegationState(row.id, "Delegation had no child runs; state repaired by sweep");
      if (changed) settled += 1;
    }
    return { checked: pendingRows.length, settled };
  }

  async function getDelegationState(parentRunId: string) {
    const parent = await deps.getRun(parentRunId);
    if (!parent) return null;

    const children = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        delegationStatus: heartbeatRuns.delegationStatus,
        createdAt: heartbeatRuns.createdAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.parentRunId, parentRunId))
      .orderBy(heartbeatRuns.createdAt);

    const delegationStatus = (parent.delegationStatus ?? null) as DelegationStatus | null;
    return {
      runId: parent.id,
      companyId: parent.companyId,
      delegationStatus,
      a2aTaskState: delegationStatus ? delegationStatusToA2ATaskState(delegationStatus) : null,
      delegationResult: parent.delegationResultJson ?? null,
      children,
    };
  }

  return {
    delegateFromRun,
    handleChildRunCompleted,
    cancelChildDelegations,
    abortParentDelegationState,
    sweepStalePendingDelegations,
    getDelegationState,
    isReportOf,
  };
}

export type RunDelegationService = ReturnType<typeof runDelegationService>;
