import { agents, companies, type Db } from "@paperclipai/db";
import { AGENT_STATUSES, COMPANY_STATUSES } from "@paperclipai/shared";
import { eq, getTableColumns } from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { supportsUnscopedTimerHeartbeat } from "../heartbeat-policy.js";
import { createHeartbeatTimerPolicy, heartbeatTimerPolicyIsWellFormed } from "./timer-policy.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "../idle-deadline-types.js";

export async function readIdleAgentTimerSchedule(tx: Pick<Db, "select">, now: number,
  env: Record<string, string | undefined> = process.env, checkBudget: () => void = () => {}): Promise<IdleDeadlineSnapshot> {
  const rows = await tx.select({ agent: getTableColumns(agents), companyStatus: companies.status,
    companyUpdatedAt: companies.updatedAt }).from(agents).leftJoin(companies, eq(companies.id, agents.companyId))
    .orderBy(agents.id).limit(idleDeadlineRowLimit + 1);
  const state: unknown[] = [rows];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const byCompany = new Map<string, typeof agents.$inferSelect[]>();
  for (const { agent } of rows) {
    const group = byCompany.get(agent.companyId) ?? [];
    group.push(agent);
    byCompany.set(agent.companyId, group);
  }
  const owner = createHeartbeatTimerPolicy(tx);
  let inspectedTimers = 0;
  const deadlines: number[] = [];
  for (const { agent, companyStatus } of rows) {
    checkBudget();
    if (!AGENT_STATUSES.includes(agent.status as typeof AGENT_STATUSES[number]) || !companyStatus || !COMPANY_STATUSES.includes(companyStatus as typeof COMPANY_STATUSES[number]) || agent.status === "running") return blocked();
    if (companyStatus !== "active") continue;
    if (!heartbeatTimerPolicyIsWellFormed(agent)) return blocked();
    const policy = owner.parseHeartbeatPolicy(agent);
    if (!Number.isFinite(policy.intervalSec)) return blocked();
    if (!policy.enabled || policy.intervalSec <= 0 || !supportsUnscopedTimerHeartbeat(agent)) continue;
    if (++inspectedTimers > 128) return blocked();
    const invokability = evaluateAgentInvokability(agent, byCompany.get(agent.companyId)!);
    if (!invokability.invokable) {
      if (invokability.invalidOrgChain || invokability.reason === "unknown_status") return blocked();
      continue;
    }
    const flags = [env.HEARTBEAT_SCHEDULER_ENABLED, env.PAPERCLIP_IN_WORKTREE,
      env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS, env.PAPERCLIP_RESTORE_IN_PROGRESS];
    state.push(flags);
    if (flags[0] === "false" || flags.slice(1).some(v => ["true", "1", "yes", "on"].includes(v ?? ""))) return blocked();
    const snapshot = await owner.readTimerHeartbeatSchedule(agent, new Date(now));
    state.push([agent.id, snapshot]);
    if (snapshot.deadline === null) continue;
    if (!isFutureIdleDeadline(snapshot.deadline, now)) return blocked();
    deadlines.push(snapshot.deadline);
  }
  return { blocked: false, state, deadlines };
}
