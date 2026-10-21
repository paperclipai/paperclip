import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { boundRunIssueIdSql } from "../run-task-binding.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export type NativeMonitorDelivery = { wakeId: string; successorRunId: string };

export async function readNativeMonitorSource(
  db: Pick<Db, "select">,
  binding: { companyId: string; issueId: string; runId: string },
): Promise<string | null> {
  const source = alias(heartbeatRuns, "monitor_source");
  const sources = await db.select({ runId: source.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.companyId, binding.companyId),
      eq(agentWakeupRequests.runId, heartbeatRuns.id),
      eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
      eq(agentWakeupRequests.reason, "issue_monitor_due"),
      ne(agentWakeupRequests.status, "skipped"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${binding.issueId}`,
      sql`${agentWakeupRequests.idempotencyKey} = 'issue-monitor:' || ${binding.issueId} || ':' || (${agentWakeupRequests.payload}->>'nextCheckAt')`,
    ))
    .innerJoin(source, and(
      eq(source.companyId, binding.companyId), eq(source.agentId, heartbeatRuns.agentId),
      eq(source.nativeIssueId, binding.issueId), eq(source.runtimeMode, "native"),
      ne(source.id, heartbeatRuns.id),
      sql`${source.responsibleUserId} is not distinct from ${heartbeatRuns.responsibleUserId}`,
      sql`${source.createdAt} <= ${agentWakeupRequests.createdAt}`,
      sql`exists (select 1 from jsonb_each(case
        when jsonb_typeof(${source.resultJson}->'semanticToolReceipts') = 'object'
        then ${source.resultJson}->'semanticToolReceipts' else '{}'::jsonb end) receipt
        where receipt.value->>'operationId' = 'set_task_monitor'
          and receipt.value->'result'->>'taskId' = ${binding.issueId}
          and receipt.value->'result'->'monitor'->>'status' = 'scheduled'
          and receipt.value->'result'->'monitor'->>'nextCheckAt' = ${agentWakeupRequests.payload}->>'nextCheckAt')`,
    ))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(boundRunIssueIdSql(), binding.issueId)))
    .groupBy(source.id).limit(2);
  return sources.length === 1 ? sources[0]!.runId : null;
}

/** A dispatched timer is historical delivery evidence, never authority to run again. */
export async function readNativeMonitorDelivery(
  db: Db,
  binding: { companyId: string; issueId: string; runId: string },
): Promise<NativeMonitorDelivery | null> {
  const [run] = await db.select({
    agentId: heartbeatRuns.agentId, resultJson: heartbeatRuns.resultJson,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.nativeIssueId, binding.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
  ));
  if (!run) return null;
  const keys = Object.values(record(run.resultJson?.semanticToolReceipts)).flatMap(value => {
    const receipt = record(value);
    const result = record(receipt.result), monitor = record(result.monitor);
    if (receipt.operationId !== "set_task_monitor" || result.taskId !== binding.issueId ||
        monitor.status !== "scheduled" || typeof monitor.nextCheckAt !== "string") return [];
    return [`issue-monitor:${binding.issueId}:${monitor.nextCheckAt}`];
  });
  if (!keys.length) return null;
  // The issue index bounds this lookup to one task. Joining the admitted run
  // excludes queued, forged, and cross-company/task delivery references.
  const [delivery] = await db.select({
    wakeId: agentWakeupRequests.id, successorRunId: heartbeatRuns.id,
  }).from(agentWakeupRequests).innerJoin(heartbeatRuns, and(
    eq(heartbeatRuns.id, agentWakeupRequests.runId),
    eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
    ne(heartbeatRuns.id, binding.runId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId',
      ${heartbeatRuns.contextSnapshot}->>'taskId') = ${binding.issueId}`,
  )).where(and(
    eq(agentWakeupRequests.companyId, binding.companyId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.reason, "issue_monitor_due"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${binding.issueId}`,
    inArray(agentWakeupRequests.idempotencyKey, keys),
  )).orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
  return delivery ?? null;
}
