import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/**
 * A native run that hands its own task to a person keeps running to finish its
 * turn. This run-scoped record names that hand-off, so the run's own terminal
 * fences accept a task it gave away on purpose. It grants no task authority:
 * the task's tools, REST mutations and status decisions already stop acting
 * for a task that belongs to a person.
 */
export const NATIVE_HUMAN_SELF_HANDOFF_KEY = "humanSelfHandoff";

export async function recordNativeHumanSelfHandoff(db: Db, input: {
  companyId: string; runId: string; agentId: string; issueId: string; assigneeUserId: string;
}): Promise<boolean> {
  const record = { issueId: input.issueId, assigneeUserId: input.assigneeUserId, recordedAt: new Date().toISOString() };
  const updated = await db.update(heartbeatRuns)
    .set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
      || jsonb_build_object(${NATIVE_HUMAN_SELF_HANDOFF_KEY}::text, ${JSON.stringify(record)}::jsonb)` })
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.status, "running")))
    .returning({ id: heartbeatRuns.id });
  return updated.length > 0;
}

/** The task now belongs to the person this run handed it to. */
export function nativeRunHandedOffTask(
  resultJson: unknown,
  issue: { id: string; assigneeAgentId: string | null; assigneeUserId: string | null },
): boolean {
  if (issue.assigneeAgentId !== null || !issue.assigneeUserId) return false;
  const handoff = resultJson && typeof resultJson === "object"
    ? (resultJson as Record<string, unknown>)[NATIVE_HUMAN_SELF_HANDOFF_KEY] : null;
  if (!handoff || typeof handoff !== "object") return false;
  const { issueId, assigneeUserId } = handoff as Record<string, unknown>;
  return issueId === issue.id && assigneeUserId === issue.assigneeUserId;
}
