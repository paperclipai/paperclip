import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { AGENT_SELF_HANDOFF_KEY } from "../run-task-ownership.js";

export async function recordAgentSelfHandoff(db: Db, input: {
  companyId: string; runId: string; agentId: string; issueId: string; assigneeAgentId: string;
}): Promise<boolean> {
  const record = {
    issueId: input.issueId,
    fromAgentId: input.agentId,
    toAgentId: input.assigneeAgentId,
    recordedAt: new Date().toISOString(),
  };
  const updated = await db.update(heartbeatRuns)
    .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
      || jsonb_build_object(${AGENT_SELF_HANDOFF_KEY}::text, ${JSON.stringify(record)}::jsonb)` })
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "legacy"),
      eq(heartbeatRuns.status, "running"),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`))
    .returning({ id: heartbeatRuns.id });
  return updated.length > 0;
}
