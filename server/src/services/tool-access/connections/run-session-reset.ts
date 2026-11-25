import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentRuntimeState, agentTaskSessions, heartbeatRuns, type Db } from "@paperclipai/db";

function readSessionId(resultJson: unknown): string[] {
  const record = resultJson && typeof resultJson === "object" && !Array.isArray(resultJson) ? resultJson as Record<string, unknown> : {};
  return [record.sessionId, record.session_id].flatMap((value) => typeof value === "string" && value ? [value] : []);
}

export async function forgetRunSessions(
  tx: Db,
  companyId: string,
  runId: string,
  run: { agentId: string; sessionIdBefore: string | null; sessionIdAfter: string | null; resultJson: unknown },
): Promise<boolean> {
  const sessionIds = [...new Set([run.sessionIdBefore, run.sessionIdAfter, ...readSessionId(run.resultJson)].flatMap((id) => id ? [id] : []))];
  const sameSession = sessionIds.length > 0
    ? or(
      inArray(agentTaskSessions.sessionDisplayId, sessionIds),
      inArray(sql<string>`${agentTaskSessions.sessionParamsJson}->>'sessionId'`, sessionIds),
    )
    : undefined;
  const removed = await tx
    .delete(agentTaskSessions)
    .where(and(
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, run.agentId),
      sameSession ? or(eq(agentTaskSessions.lastRunId, runId), sameSession) : eq(agentTaskSessions.lastRunId, runId),
    ))
    .returning({ id: agentTaskSessions.id });
  const reset = await tx
    .update(agentRuntimeState)
    .set({ sessionId: null, updatedAt: new Date() })
    .where(and(
      eq(agentRuntimeState.companyId, companyId),
      eq(agentRuntimeState.agentId, run.agentId),
      sql`${agentRuntimeState.sessionId} is not null`,
      sessionIds.length > 0 ? or(eq(agentRuntimeState.lastRunId, runId), inArray(agentRuntimeState.sessionId, sessionIds)) : eq(agentRuntimeState.lastRunId, runId),
    ))
    .returning({ agentId: agentRuntimeState.agentId });
  if (sessionIds.length === 0) return removed.length > 0 || reset.length > 0;
  const ids = sql`array[${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  const resumable = await tx
    .update(heartbeatRuns)
    .set({
      sessionIdBefore: sql`case when ${heartbeatRuns.sessionIdBefore} = any(${ids}) then null else ${heartbeatRuns.sessionIdBefore} end`,
      sessionIdAfter: sql`case when ${heartbeatRuns.sessionIdAfter} = any(${ids}) then null else ${heartbeatRuns.sessionIdAfter} end`,
      resultJson: sql`case when ${heartbeatRuns.resultJson}->>'sessionId' = any(${ids}) or ${heartbeatRuns.resultJson}->>'session_id' = any(${ids})
        then ${heartbeatRuns.resultJson} - 'sessionId' - 'session_id' else ${heartbeatRuns.resultJson} end` as never,
    })
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, run.agentId),
      sql`(${heartbeatRuns.sessionIdBefore} = any(${ids}) or ${heartbeatRuns.sessionIdAfter} = any(${ids})
        or ${heartbeatRuns.resultJson}->>'sessionId' = any(${ids}) or ${heartbeatRuns.resultJson}->>'session_id' = any(${ids}))`,
    ))
    .returning({ id: heartbeatRuns.id });
  return removed.length > 0 || reset.length > 0 || resumable.length > 0;
}

export const RUN_CONTENT_DELETED_MARKER = "contentDeletedAt";

export async function forgetSessionsOfDeletedRun(db: Db, run: { id: string; companyId: string }) {
  const [row] = await db
    .select({ agentId: heartbeatRuns.agentId, sessionIdBefore: heartbeatRuns.sessionIdBefore, sessionIdAfter: heartbeatRuns.sessionIdAfter,
      resultJson: heartbeatRuns.resultJson, deletedAt: sql<string | null>`${heartbeatRuns.resultJson}->>${RUN_CONTENT_DELETED_MARKER}` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  if (!row?.deletedAt) return false;
  return db.transaction(async (tx) => forgetRunSessions(tx as unknown as Db, run.companyId, run.id, row));
}

export async function runContentDeleted(db: Pick<Db, "select">, companyId: string, runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const [row] = await db
    .select({ deletedAt: sql<string | null>`${heartbeatRuns.resultJson}->>${RUN_CONTENT_DELETED_MARKER}` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  return Boolean(row?.deletedAt);
}
