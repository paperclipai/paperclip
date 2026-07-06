import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  DELEGATION_CHILD_COMPLETED_WAKE_REASON,
  type DelegateRunInput,
  type DelegationStatus,
  type HeartbeatRunStatus,
} from "@paperclipai/shared";
import { forbidden, conflict, notFound } from "../errors.js";
import { evaluateAgentInvokabilityFromDb, type AgentOrgRow } from "./agent-invokability.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";

const TERMINAL_PARENT_STATUSES_FOR_CONTINUATION = new Set<HeartbeatRunStatus>([
  "succeeded",
]);

function parentLivenessAfterDelegation(delegationStatus: DelegationStatus): string | null {
  if (delegationStatus === "completed") return "advanced";
  if (delegationStatus === "cancelled" || delegationStatus === "failed") return "failed";
  return null;
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      throw conflict("A delegation is already pending for this heartbeat run");
    }

    const waitTimeoutSec = Math.min(input.waitTimeoutSec, 300);

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

    const parentContext = (parent.contextSnapshot ?? {}) as Record<string, unknown>;
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
    const idempotencyKey = `delegate:${parentRunId}:${targetAgent.id}:${delegationIssueId ?? "no-issue"}`;

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
        parentIssueId,
        childIssueId,
      },
    });

    if (!childRun) {
      throw conflict("Failed to enqueue delegated agent wakeup");
    }

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
          task: input.task,
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, parentRunId));

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
        wait: input.wait,
      },
    });

    if (!input.wait) {
      return {
        parentRunId,
        childRunId: childRun.id,
        childIssueId,
        delegationStatus: "pending" as const,
        wait: false,
      };
    }

    const deadline = Date.now() + waitTimeoutSec * 1000;
    let latestChild = await deps.getRun(childRun.id);
    while (latestChild && !isTerminalRunStatus(latestChild.status) && Date.now() < deadline) {
      await sleep(2000);
      latestChild = await deps.getRun(childRun.id);
    }

    if (!latestChild) throw notFound("Delegated child run not found");

    if (!isTerminalRunStatus(latestChild.status)) {
      return {
        parentRunId,
        childRunId: childRun.id,
        childIssueId,
        delegationStatus: "pending" as const,
        wait: true,
        timedOut: true,
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

  async function finalizeParentDelegation(
    parentRunId: string,
    childRun: HeartbeatRunRow,
    delegationStatus: DelegationStatus,
    delegationResult: ReturnType<typeof buildDelegationResult>,
    options: { enqueueParentContinuation: boolean },
  ) {
    const parent = await deps.getRun(parentRunId);
    if (!parent) return;

    const nextLiveness = parentLivenessAfterDelegation(delegationStatus);
    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus,
        delegationResultJson: delegationResult as unknown as Record<string, unknown>,
        ...(nextLiveness ? { livenessState: nextLiveness } : {}),
        livenessReason:
          delegationStatus === "completed"
            ? `Delegation to child run ${childRun.id} completed`
            : delegationStatus === "cancelled"
              ? `Delegation to child run ${childRun.id} was cancelled`
              : `Delegation child run ${childRun.id} ended with ${childRun.status}`,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, parentRunId));

    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus,
        delegationResultJson: delegationResult as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, childRun.id));

    if (!options.enqueueParentContinuation) return;
    if (!TERMINAL_PARENT_STATUSES_FOR_CONTINUATION.has(parent.status as HeartbeatRunStatus)) return;
    await deps.enqueueWakeup(parent.agentId, {
        source: "automation",
        triggerDetail: "callback",
        reason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
        requestedByActorType: "system",
        requestedByActorId: "run_delegation",
        idempotencyKey: `delegation-complete:${parentRunId}:${childRun.id}`,
        contextSnapshot: {
          issueId: readNonEmptyString((parent.contextSnapshot as Record<string, unknown> | null)?.issueId),
          taskId: readNonEmptyString((parent.contextSnapshot as Record<string, unknown> | null)?.taskId),
          wakeReason: DELEGATION_CHILD_COMPLETED_WAKE_REASON,
          delegatedChildRunId: childRun.id,
          delegationResult,
          resumeFromRunId: parentRunId,
        },
        payload: {
          delegationResult,
          parentRunId,
          childRunId: childRun.id,
        },
      });
  }

  async function abortParentDelegationState(parentRunId: string, reason: string) {
    await db
      .update(heartbeatRuns)
      .set({
        delegationStatus: "cancelled",
        livenessState: "failed",
        livenessReason: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, parentRunId),
          eq(heartbeatRuns.delegationStatus, "pending"),
        ),
      );
  }

  async function handleChildRunCompleted(childRun: HeartbeatRunRow) {
    if (!childRun.parentRunId) return;
    const parent = await deps.getRun(childRun.parentRunId);
    if (!parent || parent.delegationStatus !== "pending") return;
    if (parent.status === "cancelled" || parent.status === "timed_out") {
      await abortParentDelegationState(parent.id, `Parent run ${parent.status} before child completed`);
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
      await deps.cancelRun(child.id, reason);
      await db
        .update(heartbeatRuns)
        .set({
          delegationStatus: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, child.id));
    }
    await abortParentDelegationState(parentRunId, reason);
  }

  return {
    delegateFromRun,
    handleChildRunCompleted,
    cancelChildDelegations,
    abortParentDelegationState,
    isReportOf,
  };
}

export type RunDelegationService = ReturnType<typeof runDelegationService>;
