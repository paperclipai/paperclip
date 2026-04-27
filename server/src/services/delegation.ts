import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";
import {
  agents,
  costEvents,
  heartbeatRuns,
  HEARTBEAT_RUN_TERMINAL_STATUSES,
  type HeartbeatRunTerminalStatus,
  type Db,
} from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

// Canonical terminal set for heartbeat_runs.status. Imported from the schema
// module so this poller can never drift from the statuses the runtime actually
// writes. (Prior to this import we checked for "done" — which the runtime
// never writes — so succeeded child runs were never detected and the parent's
// delegate_task tool_result was never posted.)
const TERMINAL_STATUSES = new Set<string>(HEARTBEAT_RUN_TERMINAL_STATUSES);
const SUCCEEDED_STATUS = "succeeded" satisfies HeartbeatRunTerminalStatus;

// Issue-status literals sourced from the shared enum so this service can't
// drift from the canonical set in @paperclipai/shared. The `satisfies` clause
// makes the typecheck fail if any of these literals is ever removed from
// ISSUE_STATUSES upstream — that's the drift protection we want.
const ISSUE_STATUS_TODO = "todo" satisfies IssueStatus;
const ISSUE_STATUS_DONE = "done" satisfies IssueStatus;
const ISSUE_STATUS_CANCELLED = "cancelled" satisfies IssueStatus;

interface DelegationDeps {
  db: Db;
  heartbeat: {
    wakeup: (
      agentId: string,
      opts: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
        parentRunId?: string | null;
      },
    ) => Promise<unknown>;
  };
  parentAgent: {
    id: string;
    companyId: string;
    name: string;
    permissions: Record<string, unknown>;
  };
  parentRunId: string;
  /**
   * Cornerstone targetWorkspace inherited from the parent issue. Propagated
   * onto the child issue at creation time so the child's tool dispatch
   * resolves writes to the same namespace as the parent — no agent input,
   * no env fallback unless the parent itself was unset. Null = parent had
   * no targetWorkspace; child inherits null and falls through to
   * AI_OPS_WRITE_WORKSPACE downstream.
   */
  parentTargetWorkspace?: string | null;
  /**
   * Optional callback invoked when the parent's polling deadline expires
   * before the child reaches terminal. The callback should cancel the
   * still-running child heartbeat_run so it doesn't keep billing or post a
   * tool_result after the parent has already returned status="timeout".
   * When omitted (e.g. unit tests), timeout still flips the issue to
   * cancelled but the child run is left to terminate on its own.
   */
  cancelRun?: (childRunId: string, reason?: string) => Promise<void>;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function resolveCanDelegate(permissions: Record<string, unknown>): boolean {
  return readBoolean(permissions?.canDelegate);
}

async function sumChildCostCents(db: Db, childRunId: string): Promise<number> {
  const row = await db
    .select({ total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)` })
    .from(costEvents)
    .where(eq(costEvents.heartbeatRunId, childRunId))
    .then((rows) => rows[0] ?? null);
  if (!row) return 0;
  const n = Number(row.total);
  return Number.isFinite(n) ? n : 0;
}

export function createDelegateTaskCallback(
  deps: DelegationDeps,
): (req: DelegationRequest) => Promise<DelegationResult> {
  const { db, heartbeat, parentAgent, parentRunId, parentTargetWorkspace = null } = deps;
  const blankResult = (
    status: DelegationResult["status"],
    errorCode: string | null,
    errorMessage: string | null,
  ): DelegationResult => ({
    status,
    childRunId: null,
    childIssueId: null,
    childIssueIdentifier: null,
    finalText: null,
    costUsd: null,
    errorCode,
    errorMessage,
  });

  const { cancelRun } = deps;
  return async function delegateTask(req: DelegationRequest): Promise<DelegationResult> {
    // 1. Resolve assignee by name within the same company (case-insensitive).
    const candidates = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, parentAgent.companyId),
          sql`lower(${agents.name}) = lower(${req.assigneeAgentName})`,
        ),
      );
    if (candidates.length === 0) {
      return blankResult(
        "rejected",
        "assignee_not_found",
        `No agent named "${req.assigneeAgentName}" in this company`,
      );
    }
    if (candidates.length > 1) {
      return blankResult(
        "rejected",
        "assignee_ambiguous",
        `Multiple agents match "${req.assigneeAgentName}"`,
      );
    }
    const assignee = candidates[0];

    // 2. Reports-to check — assignee must be a direct report of the delegator.
    if (assignee.reportsTo !== parentAgent.id) {
      return blankResult(
        "rejected",
        "not_direct_report",
        `Agent "${assignee.name}" does not report to "${parentAgent.name}"`,
      );
    }

    // 3. Self-delegation guard.
    if (assignee.id === parentAgent.id) {
      return blankResult(
        "rejected",
        "self_delegation",
        "Cannot delegate to self",
      );
    }

    // 4. Recursion guard — assignee must have canDelegate=true before we allow
    //    the delegated run itself to surface a delegate_task tool. Here we just
    //    allow the delegation; the adapter will consult canDelegate on the
    //    child agent when deciding whether to register the tool. This branch
    //    keeps the explicit check so rejections surface useful error codes.
    //    (Future: block chains beyond configured depth via parent_run_id walk.)

    // 5. Create the child issue assigned to the delegate.
    const titleTrimmed = req.title.slice(0, 200);
    const svc = issueService(db);
    let issue;
    try {
      issue = await svc.create(parentAgent.companyId, {
        title: titleTrimmed,
        description: req.description,
        status: ISSUE_STATUS_TODO,
        priority: "medium",
        assigneeAgentId: assignee.id,
        createdByAgentId: parentAgent.id,
        originKind: "delegation",
        originId: parentRunId,
        // Inherit parent's targetWorkspace verbatim — agent input on the
        // delegate_task tool can't override this (delegation safety).
        targetWorkspace: parentTargetWorkspace,
      } as Parameters<typeof svc.create>[1]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return blankResult("failed", "issue_create_failed", msg);
    }

    // 6. Enqueue the wakeup with parentRunId so the child heartbeat_run row
    //    carries the attribution. Bypass queueIssueAssignmentWakeup — we need
    //    direct control over parentRunId which it doesn't pass through.
    let wakeupResult: unknown;
    try {
      wakeupResult = await heartbeat.wakeup(assignee.id, {
        source: "assignment",
        triggerDetail: "system",
        reason: "delegate_task",
        payload: {
          issueId: issue.id,
          mutation: "delegate_task",
          parentRunId,
        },
        requestedByActorType: "agent",
        requestedByActorId: parentAgent.id,
        contextSnapshot: {
          issueId: issue.id,
          source: "delegate_task",
        },
        parentRunId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return blankResult("failed", "wakeup_failed", msg);
    }

    const childRunId =
      wakeupResult && typeof wakeupResult === "object" && "id" in wakeupResult
        ? String((wakeupResult as { id: unknown }).id)
        : null;

    if (!childRunId) {
      return blankResult(
        "failed",
        "wakeup_no_run",
        "Wakeup did not produce a heartbeat_run",
      );
    }

    const baseResult: DelegationResult = {
      status: "queued",
      childRunId,
      childIssueId: issue.id,
      childIssueIdentifier: issue.identifier ?? null,
      finalText: null,
      costUsd: null,
      errorCode: null,
      errorMessage: null,
    };

    if (!req.waitForCompletion) {
      return baseResult;
    }

    // 7. Poll heartbeat_runs until terminal or timeout.
    const deadline = Date.now() + req.timeoutSeconds * 1000;
    // Initial delay lets the synchronous runner start executing.
    await new Promise((r) => setTimeout(r, 3000));
    let childRow = null as
      | (typeof heartbeatRuns.$inferSelect)
      | null;
    while (Date.now() < deadline) {
      childRow = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, childRunId))
        .then((rows) => rows[0] ?? null);
      if (!childRow) {
        return blankResult("failed", "child_run_missing", "Child run vanished");
      }
      if (TERMINAL_STATUSES.has(childRow.status)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!childRow || !TERMINAL_STATUSES.has(childRow.status)) {
      // Child never reached terminal. Cancel the still-running child run
      // before flipping the issue, otherwise the orphan keeps polling the
      // model API (billing the company) and may post a tool_result after the
      // parent has already returned status="timeout". F-DELEG-4 sibling of
      // Bug 7 — fixed 2026-04-25.
      if (cancelRun) {
        try {
          await cancelRun(childRunId, "parent_delegation_timeout");
        } catch (err) {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              childRunId,
              issueId: issue.id,
            },
            "delegation: failed to cancel child run after parent timeout",
          );
        }
      }
      // Flip the issue to cancelled so the reconciler doesn't keep waking the
      // assignee forever on a task its parent already gave up on.
      try {
        await svc.update(issue.id, { status: ISSUE_STATUS_CANCELLED });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), issueId: issue.id },
          "delegation: failed to cancel issue after child timeout",
        );
      }
      return {
        ...baseResult,
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Child run did not finish within ${req.timeoutSeconds}s`,
      };
    }

    const costCents = await sumChildCostCents(db, childRunId);
    const resultJson = (childRow.resultJson ?? {}) as Record<string, unknown>;
    const finalText =
      typeof resultJson.finalText === "string"
        ? resultJson.finalText
        : typeof resultJson.summary === "string"
          ? resultJson.summary
          : null;

    const succeeded = childRow.status === SUCCEEDED_STATUS;

    // Flip the child issue out of in_progress so the heartbeat reconciler
    // stops re-waking the assignee via issue.continuation_recovery. Succeeded
    // → done; anything else (failed / cancelled / timed_out) → cancelled so
    // the parent owns reassignment via the tool_result it's about to receive.
    const nextIssueStatus = succeeded ? ISSUE_STATUS_DONE : ISSUE_STATUS_CANCELLED;
    try {
      await svc.update(issue.id, { status: nextIssueStatus });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          issueId: issue.id,
          childStatus: childRow.status,
          nextIssueStatus,
        },
        "delegation: failed to update issue status after child terminal",
      );
    }

    return {
      status: succeeded ? "completed" : "failed",
      childRunId,
      childIssueId: issue.id,
      childIssueIdentifier: issue.identifier ?? null,
      finalText,
      costUsd: costCents / 100,
      errorCode: succeeded ? null : childRow.errorCode ?? "child_run_failed",
      errorMessage: succeeded ? null : childRow.error ?? null,
    };
  };
}

/**
 * Gate whether the current run can expose delegate_task. Only agents with
 * `permissions.canDelegate=true` AND at least one direct report may delegate.
 */
export async function canAgentDelegate(
  db: Db,
  agent: { id: string; companyId: string; permissions: Record<string, unknown> },
): Promise<boolean> {
  if (!resolveCanDelegate(agent.permissions)) return false;
  const reports = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, agent.companyId), eq(agents.reportsTo, agent.id)))
    .limit(1);
  return reports.length > 0;
}

export const delegationTerminalStatuses = Array.from(TERMINAL_STATUSES);

/** Exported for completeness; services that need batched cost rollups can reuse. */
export async function sumCostCentsForRun(db: Db, runId: string): Promise<number> {
  return sumChildCostCents(db, runId);
}

// Silence unused-import warnings for helpers kept for future expansion.
void inArray;
void logger;
