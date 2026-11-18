import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/**
 * Whether a chat request (for example a GitHub push or a Slack reply) waits as
 * a deferred wake behind the agent's current run on this task.
 *
 * A chat wake never joins another run's turn (`deferredWakeJoinsFirstTurn`):
 * the run it starts binds that request's own source, so its tools act on what
 * the request asked for. Work that would otherwise continue the current run
 * in a fresh session yields to it instead.
 */
export async function hasQueuedChatRequest(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.runId} is null`,
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`(nullif(${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'chatConversationId', '') is not null
      or nullif(${agentWakeupRequests.payload}->>'externalChatProvider', '') is not null)`,
  )).limit(1);
  return Boolean(wake);
}
