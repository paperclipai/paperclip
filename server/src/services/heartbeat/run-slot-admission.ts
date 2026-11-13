import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { maxConcurrentRunsSql } from "./timer-policy.js";

export class AgentRunSlotsFull extends Error {
  constructor(readonly agentId: string, readonly running: number, readonly limit: number) {
    super("The agent already runs as many runs at once as it allows.");
    this.name = "AgentRunSlotsFull";
  }
}

export async function assertAgentRunSlotFree(tx: Pick<Db, "select">, companyId: string, agentId: string) {
  const [slots] = await tx.select({
    limit: maxConcurrentRunsSql(),
    running: sql<number>`(select count(*)::int from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${companyId}::uuid and ${heartbeatRuns.agentId} = ${agentId}::uuid and ${heartbeatRuns.status} = 'running')`,
  }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (!slots) return;
  const running = Number(slots.running);
  const limit = Number(slots.limit);
  if (running >= limit) throw new AgentRunSlotsFull(agentId, running, limit);
}
