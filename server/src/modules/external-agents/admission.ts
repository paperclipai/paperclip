import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, dotRunnerAssignments, externalAgentHolds, museRunnerAssignments } from "@paperclipai/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { conflict } from "../../errors.js";
export type ExternalAdmissionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Acquire only after the queue's issue/wake/run locks. Generation/stop operations acquire this guard before binding locks. */
export async function withExternalAdmissionGuard<T>(tx: ExternalAdmissionTransaction, companyId: string, agentId: string, action: () => Promise<T>): Promise<T> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:external-admission:${companyId}:${agentId}`},0))`);
  return action();
}
export async function assertNoExternalOverlap(tx: ExternalAdmissionTransaction, companyId: string, agentId: string): Promise<void> {
  const [hold] = await tx.select({ id: externalAgentHolds.id }).from(externalAgentHolds).where(and(eq(externalAgentHolds.companyId,companyId),eq(externalAgentHolds.agentId,agentId),isNull(externalAgentHolds.releasedAt),or(eq(externalAgentHolds.workerUnknown,true),eq(externalAgentHolds.nativeEffectsUnknown,true)))).limit(1);
  const [muse] = await tx.select({ id:museRunnerAssignments.id }).from(museRunnerAssignments).where(and(eq(museRunnerAssignments.companyId,companyId),eq(museRunnerAssignments.agentId,agentId),inArray(museRunnerAssignments.status,["offered","claimed","accepted"]))).limit(1);
  const [dot] = await tx.select({ id:dotRunnerAssignments.id }).from(dotRunnerAssignments).where(and(eq(dotRunnerAssignments.companyId,companyId),eq(dotRunnerAssignments.agentId,agentId),inArray(dotRunnerAssignments.status,["offered","accepted"]))).limit(1);
  const [claimed] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agentId),eq(heartbeatRuns.status,"running"),or(inArray(heartbeatRuns.driverKind,["openai_dot_mcp","muse_external"]),sql`exists (select 1 from ${agents} where ${agents.id} = ${agentId}::uuid and ${agents.companyId} = ${companyId}::uuid and ${agents.adapterConfig}->>'provider' in ('openai_dot','muse'))`))).limit(1);
  if (hold || muse || dot || claimed) throw conflict("External work is live or unresolved for this agent. Reconcile the exact assignment before starting another run.", { code: "external_agent_overlap" });
}
