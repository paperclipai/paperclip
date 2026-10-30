import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

export async function readNativeStopExecutionEvidence(db: Db, companyId: string, runId: string) {
  const [run] = await db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    nativeIssueId: heartbeatRuns.nativeIssueId,
    status: heartbeatRuns.status,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
    resultJson: sql<typeof heartbeatRuns.$inferSelect.resultJson>`case
      when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object' then (
        select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
        from jsonb_each(${heartbeatRuns.resultJson})
        where key = any(array['nativeCancellation', 'cancelledByActorType', 'cancelledByUserId'])
      ) else null end`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).limit(1);
  return run ?? null;
}
