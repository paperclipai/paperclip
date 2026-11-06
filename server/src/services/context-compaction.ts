import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { IssueContextCompaction } from "@paperclipai/shared";

/**
 * On-demand context compaction ("Compact now").
 *
 * Agents run with a per-turn session lifecycle: the harness session exists
 * only during a run. A compaction therefore runs as its own short heartbeat
 * run that resumes the assignee's session, asks the harness to compact (Codex
 * `thread/compact/start`, Claude's ACP `/compact` command), and settles
 * without changing the task. The run is marked by
 * `contextSnapshot.contextCompactionRequestId`.
 */

export const CONTEXT_COMPACTION_WAKE_REASON = "context_compaction";

const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

type AgentBinding = Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The compaction request a run was admitted for, if it is a compaction run. */
export function readContextCompactionRequest(
  context: unknown,
): { requestId: string; contextTokensBefore?: number } | null {
  const record = asRecord(context);
  const requestId = nonEmptyString(record.contextCompactionRequestId);
  if (!requestId) return null;
  const before = record.contextCompactionTokensBefore;
  return typeof before === "number" && Number.isSafeInteger(before) && before >= 0
    ? { requestId, contextTokensBefore: before }
    : { requestId };
}

export function isContextCompactionRun(context: unknown): boolean {
  return readContextCompactionRequest(context) !== null;
}

/**
 * Harnesses that can compact on request. Compaction needs the Paperclip
 * runner, which resumes the provider session: Codex through its app-server,
 * Claude through ACP.
 */
export function contextCompactionSupport(agent: AgentBinding): { supported: true } | { supported: false; reason: string } {
  const unsupported = { supported: false as const, reason: "This agent's harness can't compact on request." };
  if (agent.adapterType !== "paperclip_runner") return unsupported;
  const config = asRecord(agent.adapterConfig);
  const provider = typeof config.provider === "string" ? config.provider : "codex";
  if (provider === "codex") return { supported: true };
  if (provider === "acpx" && config.acpxAgent === "claude") return { supported: true };
  return unsupported;
}

export class ContextCompactionError extends Error {
  constructor(
    readonly code: "no_assignee" | "task_closed" | "unsupported" | "agent_busy" | "already_pending" | "wake_skipped",
    message: string,
  ) {
    super(message);
  }
}

type WakeupFn = (
  agentId: string,
  options: {
    source: "on_demand";
    triggerDetail: "manual";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "user";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<{ id: string } | null>;

export function contextCompactionService(db: Db, deps: { wakeup?: WakeupFn } = {}) {
  /** The assignee's newest unfinished run for this task, if any. */
  async function activeRun(companyId: string, issueId: string, agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        or(
          eq(heartbeatRuns.issueId, issueId),
          eq(heartbeatRuns.nativeIssueId, issueId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      ))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function availability(
    companyId: string,
    issue: { id: string; assigneeAgentId: string | null; status: string },
  ): Promise<IssueContextCompaction> {
    if (issue.status === "done" || issue.status === "cancelled") {
      return { status: "unavailable", reasonCode: "task_closed", reason: "Available while the task is open." };
    }
    if (!issue.assigneeAgentId) {
      return { status: "unavailable", reasonCode: "no_assignee", reason: "Assign an agent to compact its context." };
    }
    const agent = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      return { status: "unavailable", reasonCode: "no_assignee", reason: "Assign an agent to compact its context." };
    }
    const support = contextCompactionSupport(agent);
    if (!support.supported) return { status: "unavailable", reasonCode: "unsupported", reason: support.reason };
    const run = await activeRun(companyId, issue.id, issue.assigneeAgentId);
    if (run && isContextCompactionRun(run.contextSnapshot)) {
      return { status: "pending", reasonCode: null, reason: null, runId: run.id };
    }
    if (run) {
      // Compacting interrupts a turn, so wait for the current run to end.
      return {
        status: "unavailable",
        reasonCode: "agent_busy",
        reason: "Available when the agent finishes its current run.",
      };
    }
    return { status: "available", reasonCode: null, reason: null };
  }

  /** Queues a compaction run for the task's assignee. */
  async function request(input: {
    companyId: string;
    issue: { id: string; assigneeAgentId: string | null; status: string };
    userId: string;
    /** The session's last context reading, shown as the divider's "before" size. */
    contextTokensBefore?: number | null;
  }): Promise<{ requestId: string; runId: string }> {
    const current = await availability(input.companyId, input.issue);
    if (current.status === "pending") {
      throw new ContextCompactionError("already_pending", "The agent is already compacting its context.");
    }
    if (current.status === "unavailable") {
      throw new ContextCompactionError(
        current.reasonCode ?? "unsupported",
        current.reason ?? "Context compaction is unavailable.",
      );
    }
    if (!deps.wakeup) throw new Error("context compaction wakeup is not configured");
    const agentId = input.issue.assigneeAgentId!;
    const requestId = randomUUID();
    const run = await deps.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: CONTEXT_COMPACTION_WAKE_REASON,
      payload: { issueId: input.issue.id, requestId, intent: CONTEXT_COMPACTION_WAKE_REASON },
      idempotencyKey: `${CONTEXT_COMPACTION_WAKE_REASON}:${requestId}`,
      requestedByActorType: "user",
      requestedByActorId: input.userId,
      contextSnapshot: {
        issueId: input.issue.id,
        taskKey: input.issue.id,
        resumeIntent: true,
        contextCompactionRequestId: requestId,
        ...(typeof input.contextTokensBefore === "number"
          ? { contextCompactionTokensBefore: input.contextTokensBefore }
          : {}),
        skipIssueComment: true,
      },
    });
    if (!run) {
      throw new ContextCompactionError(
        "wake_skipped",
        "Compaction did not start. Check that task execution is enabled for this instance and agent, then retry.",
      );
    }
    return { requestId, runId: run.id };
  }

  return { availability, request };
}
