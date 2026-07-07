import { and, eq, inArray } from "drizzle-orm";
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
 * every child finishes. `succeeded` covers the documented wait:false contract
 * (delegate, exit, get woken with the joined results). `timed_out` is included
 * so a parent that died waiting does not waste the children's completed work.
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

const DELEGATION_DEPTH_HARD_CAP = 10;
const DELEGATION_CHILDREN_HARD_CAP = 20;

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

/**
 * Per-agent delegation policy overrides (OpenCode-style per-agent task
 * budgets), read from `agent.runtimeConfig.delegation`.
 */
export function parseDelegationPolicy(runtimeConfig: unknown): { maxDepth: number; maxChildren: number } {
  const config =
    runtimeConfig && typeof runtimeConfig === "object"
      ? ((runtimeConfig as Record<string, unknown>).delegation as Record<string, unknown> | undefined)
      : undefined;
  const clamp = (value: unknown, fallback: number, cap: number) => {
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(cap, parsed));
  };
  return {
    maxDepth: clamp(config?.maxDepth, DELEGATION_MAX_DEPTH, DELEGATION_DEPTH_HARD_CAP),
    maxChildren: clamp(config?.maxChildren, DELEGATION_MAX_CHILDREN_PER_RUN, DELEGATION_CHILDREN_HARD_CAP),
  };
}

function buildDelegationResult(child: HeartbeatRunRow) {
  const resultJson = child.resultJson && typeof child.resultJson === "object" ? child.resultJson : {};
  const context = (child.contextSnapshot ?? {}) as Record<string, unknown>;
  const summary =
    readNonEmptyString(child.nextAction) ??
    readNonEmptyString((resultJson as Record<string, unknown>).summary) ??
    readNonEmptyString((resultJson as Record<string, unknown>).message) ??
    readNonEmptyString(child.livenessReason) ??
    null;
  return {
    childRunId: child.id,
    childAgentId: child.agentId,
    childStatus: child.status,
    task: readNonEmptyString(context.delegationTask),
    clientKey: readNonEmptyString(context.delegationClientKey),
    summary,
    resultJson,
    error: child.error,
    errorCode: child.errorCode,
  };
}

function delegationStatusFromChild(child: Pick<HeartbeatRunRow, "status">): DelegationStatus {
  if (child.status === "succeeded") return "completed";
  if (child.status === "cancelled") return "cancelled";
  return "failed";
}

/** Promise.allSettled-style aggregate over the whole fan-out. */
function aggregateDelegationStatus(children: Array<Pick<HeartbeatRunRow, "status">>): DelegationStatus {
  const statuses = children.map((child) => delegationStatusFromChild(child));
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.some((status) => status === "failed")) return "failed";
  return "cancelled";
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
    if (timeoutMs <= 0) return initial;

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

  /** Join wait: block until every child of the run is terminal or the deadline passes. */
  async function waitForAllChildrenTerminal(parentRunId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const children = await listChildren(parentRunId);
      const nonTerminal = children.filter((child) => !isTerminalRunStatus(child.status));
      if (nonTerminal.length === 0) return { allTerminal: true as const, children };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { allTerminal: false as const, children };
      await waitForChildTerminal(nonTerminal[0]!.id, remaining);
    }
  }

  async function listChildren(parentRunId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.parentRunId, parentRunId))
      .orderBy(heartbeatRuns.createdAt);
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

  async function findChildByClientKey(parentRunId: string, clientKey: string) {
    const children = await listChildren(parentRunId);
    return children.find((child) => {
      const context = (child.contextSnapshot ?? {}) as Record<string, unknown>;
      return readNonEmptyString(context.delegationClientKey) === clientKey;
    }) ?? null;
  }

  /**
   * Resolve a follow-up target: a previous delegated child run whose session
   * the new delegation should resume. The prior child must belong to a run
   * owned by the delegating agent and target the same agent.
   */
  async function resolveFollowUpChild(input: {
    followUpToChildRunId: string;
    sourceAgentId: string;
    targetAgentId: string;
  }) {
    const priorChild = await deps.getRun(input.followUpToChildRunId);
    if (!priorChild || !priorChild.parentRunId) {
      throw notFound("Follow-up child run not found or not a delegated run");
    }
    if (priorChild.agentId !== input.targetAgentId) {
      throw conflict("Follow-up must target the same agent as the original delegation", {
        originalAgentId: priorChild.agentId,
      });
    }
    const priorParent = await deps.getRun(priorChild.parentRunId);
    if (!priorParent || priorParent.agentId !== input.sourceAgentId) {
      throw forbidden("Follow-up is only allowed on delegations you originated");
    }
    if (!isTerminalRunStatus(priorChild.status)) {
      throw conflict("Follow-up requires the original child run to be finished", {
        childStatus: priorChild.status,
      });
    }
    return priorChild;
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

    const parentContext = (parent.contextSnapshot ?? {}) as Record<string, unknown>;

    // Idempotent retry: same clientKey returns the existing child.
    const clientKey = readNonEmptyString(input.clientKey);
    if (clientKey) {
      const existing = await findChildByClientKey(parentRunId, clientKey);
      if (existing) {
        const status: DelegationStatus = isTerminalRunStatus(existing.status)
          ? delegationStatusFromChild(existing)
          : "pending";
        return {
          parentRunId,
          childRunId: existing.id,
          childIssueId: null,
          delegationStatus: status,
          a2aTaskState: delegationStatusToA2ATaskState(status),
          wait: false,
          reused: true,
          ...(isTerminalRunStatus(existing.status)
            ? { delegationResult: buildDelegationResult(existing) }
            : {}),
        };
      }
    }

    const [sourceRuntime] = await db
      .select({ runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, sourceAgentId))
      .limit(1);
    const policy = parseDelegationPolicy(sourceRuntime?.runtimeConfig);

    const childDepth = nextDelegationDepth(parentContext);
    if (childDepth > policy.maxDepth) {
      throw conflict(
        `Delegation depth limit reached (max ${policy.maxDepth}); complete this work directly or restructure via child issues`,
        { delegationDepth: childDepth, maxDepth: policy.maxDepth },
      );
    }

    const existingChildren = await listChildren(parentRunId);
    if (existingChildren.length >= policy.maxChildren) {
      throw conflict(
        `Delegation budget exhausted for this run (max ${policy.maxChildren} children)`,
        { childCount: existingChildren.length, maxChildren: policy.maxChildren },
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

    // Multi-turn follow-up resumes the prior child's adapter session.
    const followUpChild = input.followUpToChildRunId
      ? await resolveFollowUpChild({
          followUpToChildRunId: input.followUpToChildRunId,
          sourceAgentId,
          targetAgentId: targetAgent.id,
        })
      : null;
    const followUpContext = (followUpChild?.contextSnapshot ?? {}) as Record<string, unknown>;

    const parentIssueId = followUpChild
      ? readNonEmptyString(followUpContext.parentIssueId)
      : await resolveIssueId(sourceAgent.companyId, input.issueId, parentContext);

    let childIssueId: string | null = followUpChild
      ? readNonEmptyString(followUpContext.childIssueId) ?? readNonEmptyString(followUpContext.issueId)
      : null;
    if (!followUpChild && input.createChildIssue && parentIssueId) {
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
          ...(input.expectedOutput ? ["", "### Expected output", input.expectedOutput] : []),
        ].join("\n"),
        sourceRunId: parentRunId,
        sourceAgentId: sourceAgent.id,
      });
    }

    const delegationIssueId = childIssueId ?? parentIssueId;
    const idempotencyKey = `delegate:${parentRunId}:${targetAgent.id}:${delegationIssueId ?? "no-issue"}:${existingChildren.length}`;

    const handoffMarkdown = [
      followUpChild ? "## A2A delegation follow-up (Paperclip)" : "## A2A delegation (Paperclip)",
      `From agent: ${sourceAgent.name}`,
      `Parent run: ${parentRunId}`,
      delegationIssueId ? `Issue: ${delegationIssueId}` : null,
      followUpChild ? `Continues session from run: ${followUpChild.id}` : null,
      "",
      input.task,
      ...(input.expectedOutput ? ["", "### Expected output", input.expectedOutput] : []),
    ].filter((line): line is string => line !== null).join("\n");

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
        ...(followUpChild ? { resumeFromRunId: followUpChild.id } : {}),
        paperclipSessionHandoffMarkdown: handoffMarkdown,
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
        ...(clientKey ? { delegationClientKey: clientKey } : {}),
        ...(input.expectedOutput ? { delegationExpectedOutput: input.expectedOutput } : {}),
        ...(followUpChild ? { delegationFollowUpOfRunId: followUpChild.id } : {}),
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
            lastDelegatedChildRunId: childRun.id,
            childCount: existingChildren.length + 1,
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
        followUpOfRunId: followUpChild?.id ?? null,
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
    await mirrorChildDelegationStatus(latestChild);
    const siblings = await listChildren(parentRunId);
    const allTerminal = siblings.every((sibling) => isTerminalRunStatus(sibling.status));
    if (allTerminal) {
      await settleParentDelegation(parentRunId, siblings, { enqueueParentContinuation: false });
    }

    return {
      parentRunId,
      childRunId: childRun.id,
      childIssueId,
      delegationStatus,
      a2aTaskState: delegationStatusToA2ATaskState(delegationStatus),
      wait: true,
      timedOut: false,
      allChildrenTerminal: allTerminal,
      pendingChildren: siblings.filter((sibling) => !isTerminalRunStatus(sibling.status)).length,
      childRun: {
        id: latestChild.id,
        status: latestChild.status,
        resultJson: latestChild.resultJson,
      },
      delegationResult,
    };
  }

  /** Mirror the terminal delegation status onto the child row (informational). */
  async function mirrorChildDelegationStatus(childRun: HeartbeatRunRow) {
    if (!isTerminalRunStatus(childRun.status)) return;
    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus: delegationStatusFromChild(childRun),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, childRun.id),
          eq(heartbeatRuns.delegationStatus, "pending"),
        ),
      );
  }

  /**
   * Join + compare-and-set settle: aggregates all children and flips the
   * parent's `delegationStatus` away from `pending`. Only the CAS winner
   * performs side effects (the joined continuation wake), which makes the
   * wait:true HTTP path, concurrent child finalizers, and the sweep race-safe.
   */
  async function settleParentDelegation(
    parentRunId: string,
    children: HeartbeatRunRow[],
    options: { enqueueParentContinuation: boolean },
  ): Promise<boolean> {
    if (children.length === 0) return false;
    const results = children.map((child) => buildDelegationResult(child));
    const aggregate = aggregateDelegationStatus(children);
    const counts = {
      total: children.length,
      completed: children.filter((child) => child.status === "succeeded").length,
      failed: children.filter((child) => child.status === "failed" || child.status === "timed_out").length,
      cancelled: children.filter((child) => child.status === "cancelled").length,
    };

    const updatedParent = await db
      .update(heartbeatRuns)
      .set({
        delegationStatus: aggregate,
        delegationResultJson: { aggregate, counts, children: results } as unknown as Record<string, unknown>,
        ...(aggregate === "completed" ? { livenessState: "advanced" } : { livenessState: "needs_followup" }),
        livenessReason:
          aggregate === "completed"
            ? `All ${counts.total} delegated child run(s) completed`
            : `Delegated children finished with mixed outcomes (${counts.completed} ok, ${counts.failed} failed, ${counts.cancelled} cancelled)`,
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

    // Lost the CAS (another path already settled) — no side effects.
    if (!updatedParent) return false;

    // Keep child mirror flags consistent so the sweep never re-processes them.
    for (const child of children) {
      await mirrorChildDelegationStatus(child);
    }

    if (!options.enqueueParentContinuation) return true;
    if (!CONTINUATION_ELIGIBLE_PARENT_STATUSES.has(updatedParent.status as HeartbeatRunStatus)) return true;

    const parentContext = updatedParent.contextSnapshot as Record<string, unknown> | null;
    await deps.enqueueWakeup(updatedParent.agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
      requestedByActorType: "system",
      requestedByActorId: "run_delegation",
      idempotencyKey: `delegation-complete:${parentRunId}`,
      contextSnapshot: {
        issueId: readNonEmptyString(parentContext?.issueId),
        taskId: readNonEmptyString(parentContext?.taskId),
        wakeReason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
        delegationAggregate: aggregate,
        delegationCounts: counts,
        delegationResults: results,
        delegationDepth: typeof parentContext?.delegationDepth === "number" ? parentContext.delegationDepth : 0,
        delegationParentRunId: parentRunId,
      },
      payload: {
        delegationAggregate: aggregate,
        delegationResults: results,
        parentRunId,
      },
    });
    return true;
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
   * return immediately, then joins the fan-out: the parent settles only after
   * ALL children reach a terminal status (one wake with all results).
   */
  async function handleChildRunCompleted(childRun: HeartbeatRunRow) {
    if (!childRun.parentRunId) return;
    notifyChildRunTerminal(childRun);
    await mirrorChildDelegationStatus(childRun);

    const parent = await deps.getRun(childRun.parentRunId);
    if (!parent || parent.delegationStatus !== "pending") return;
    if (parent.status === "cancelled") {
      await abortParentDelegationState(parent.id, `Parent run cancelled before child ${childRun.id} completed`);
      return;
    }

    const children = await listChildren(childRun.parentRunId);
    if (!children.every((child) => isTerminalRunStatus(child.status))) return;

    const settledNow = await settleParentDelegation(childRun.parentRunId, children, {
      enqueueParentContinuation: true,
    });
    if (!settledNow) return;

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
        childCount: children.length,
        aggregate: aggregateDelegationStatus(children),
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

  /** Cancel one specific delegated child (Cursor-style interrupt of a single subagent). */
  async function cancelDelegatedChild(parentRunId: string, childRunId: string, reason: string) {
    const child = await deps.getRun(childRunId);
    if (!child || child.parentRunId !== parentRunId) {
      throw notFound("Delegated child run not found for this parent run");
    }
    if (isTerminalRunStatus(child.status)) return child;

    const cancelled = await deps.cancelRun(childRunId, reason);
    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus: "cancelled",
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, childRunId));
    if (cancelled) {
      notifyChildRunTerminal(cancelled);
      // Cancelling one child may complete the join for the remaining fan-out.
      await handleChildRunCompleted({ ...cancelled, parentRunId });
    }
    return cancelled;
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

      const children = await listChildren(row.id);

      if (children.length > 0) {
        // Row is a delegating parent (possibly mid-chain). Settle it once all
        // children are terminal.
        if (!children.every((child) => isTerminalRunStatus(child.status))) continue;
        const didSettle = await settleParentDelegation(row.id, children, { enqueueParentContinuation: true });
        if (didSettle) settled += 1;
        continue;
      }

      if (row.parentRunId) {
        // Pure child mirror row: settled by its parent's sweep entry when the
        // child is terminal; a still-running child is healthy, skip.
        if (!isTerminalRunStatus(current.status)) continue;
        await handleChildRunCompleted(current);
        settled += 1;
        continue;
      }

      // Pending flag with no children and no parent: bookkeeping failed
      // mid-delegate; repair so the run does not stay pending forever.
      const changed = await abortParentDelegationState(row.id, "Delegation had no child runs; state repaired by sweep");
      if (changed) settled += 1;
    }
    return { checked: pendingRows.length, settled };
  }

  async function getDelegationState(parentRunId: string, options?: { waitAllSec?: number }) {
    const parent = await deps.getRun(parentRunId);
    if (!parent) return null;

    if (options?.waitAllSec && options.waitAllSec > 0) {
      const timeoutMs = Math.min(options.waitAllSec, DELEGATION_WAIT_TIMEOUT_MAX_SEC) * 1000;
      await waitForAllChildrenTerminal(parentRunId, timeoutMs);
    }

    const children = await listChildren(parentRunId);
    const pendingChildren = children.filter((child) => !isTerminalRunStatus(child.status)).length;
    const latestParent = await deps.getRun(parentRunId);
    const delegationStatus = (latestParent?.delegationStatus ?? null) as DelegationStatus | null;

    return {
      runId: parent.id,
      companyId: parent.companyId,
      delegationStatus,
      a2aTaskState: delegationStatus ? delegationStatusToA2ATaskState(delegationStatus) : null,
      delegationResult: latestParent?.delegationResultJson ?? null,
      allChildrenTerminal: children.length > 0 && pendingChildren === 0,
      pendingChildren,
      children: children.map((child) => ({
        id: child.id,
        agentId: child.agentId,
        status: child.status,
        delegationStatus: child.delegationStatus,
        result: isTerminalRunStatus(child.status) ? buildDelegationResult(child) : null,
        createdAt: child.createdAt,
        finishedAt: child.finishedAt,
      })),
    };
  }

  return {
    delegateFromRun,
    handleChildRunCompleted,
    cancelChildDelegations,
    cancelDelegatedChild,
    abortParentDelegationState,
    sweepStalePendingDelegations,
    getDelegationState,
    isReportOf,
  };
}

export type RunDelegationService = ReturnType<typeof runDelegationService>;
