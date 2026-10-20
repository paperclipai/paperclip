import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export type NativeMonitorDelivery = { wakeId: string; successorRunId: string };

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
