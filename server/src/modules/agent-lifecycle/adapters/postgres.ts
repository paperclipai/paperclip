import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agents, agentApiKeys, companies, budgetPolicies, type Db } from "@paperclipai/db";
import type { AgentLifecycleOperation } from "@paperclipai/shared";
import { AgentLifecycleConflict, compatibilityStatus, isLifecycleWorkPending, transition, type LifecycleCommand } from "../domain/policy.js";
import type { LifecycleEffects } from "./effects.js";
import type { LifecycleStore } from "../application/ports.js";

export function assertRootDatabase(db: Db) {
  if ("nestedIndex" in db) throw new AgentLifecycleConflict("Lifecycle commands require the root database connection");
}

type LifecycleRow = typeof agents.$inferSelect;
type ChangeOptions = { version?: number; owner?: string; reason?: string };

// Prepared drafts wait for the wizard; they have no background verification obligation.
export const pendingLifecycleWork = and(
  inArray(agents.lifecycleState, ["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"]),
  sql`not (${agents.lifecycleState} = 'verifying' and ${agents.lifecycleHolds} @> '["setup"]'::jsonb)`,
);

/** The caller owns the accounting transaction and has locked this agent. */
async function changeLockedAgent(tx: Db, effects: LifecycleEffects, agent: LifecycleRow,
  command: LifecycleCommand, options: ChangeOptions = {}, policyHolds?: string[], restartPause = false) {
  if (options.version !== undefined && options.version !== agent.lifecycleVersion) return null;
  if (command === "resume" && agent.lifecycleHolds.includes("setup")) throw new AgentLifecycleConflict("Finish agent setup before resuming");
  if (command === "complete" && (!options.owner || !agent.lifecycleOperation?.leaseUntil || agent.lifecycleOperation?.leaseOwner !== options.owner ||
    Date.parse(agent.lifecycleOperation?.leaseUntil ?? "") <= Date.now() ||
    !agent.lifecycleOperation.hostComplete || agent.lifecycleRequiredPluginIds === null ||
    agent.lifecycleRequiredPluginIds.some(id => !agent.lifecycleOperation!.completedPluginIds.includes(id)))) return null;
  if (command === "retry") {
    transition(agent.lifecycleState, command);
    if (agent.lifecycleOperation?.leaseUntil && Date.parse(agent.lifecycleOperation.leaseUntil) > Date.now()) return agent;
    await effects.notifyWork(tx);
    const [updated] = await tx.update(agents).set({ lifecycleError: null,
      lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt' - 'leaseOwner' - 'leaseUntil'`, updatedAt: new Date() }).where(eq(agents.id, agent.id)).returning();
    return updated;
  }
  if (command === "abort") {
    if (agent.lifecycleState !== "pausing") throw new AgentLifecycleConflict(`Cannot abort an agent in state ${agent.lifecycleState}`);
    if (agent.lifecycleOperation?.leaseUntil && Date.parse(agent.lifecycleOperation.leaseUntil) > Date.now()) {
      throw new AgentLifecycleConflict("A stop attempt is in flight for this agent; retry the abort once that attempt yields");
    }
    const retained = agent.lifecycleHolds.filter(hold => hold !== "manual");
    if (retained.length) throw new AgentLifecycleConflict(`Clear this agent's ${retained.join(", ")} hold before abandoning its pause`);
  }
  if (command === "resume" && !["ready", "paused", "resuming"].includes(agent.lifecycleState)) transition(agent.lifecycleState, command);
  let holds = policyHolds ?? agent.lifecycleHolds;
  const reason = options.reason ?? "manual";
  if (command === "reconcile" && policyHolds === undefined) {
    if (["pending_approval", "terminating", "cleaning_up", "terminated", "rejected"].includes(agent.lifecycleState)) return agent;
    const [company] = await tx.select().from(companies).where(eq(companies.id, agent.companyId));
    const policies = await tx.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, agent.companyId),
      eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, agent.id)));
    let budgetBlocked = false;
    for (const policy of policies) if (await effects.policyBlocks(tx, policy)) budgetBlocked = true;
    holds = holds.filter(hold => hold !== "budget" && hold !== "company_archived" && hold !== "company_paused");
    if (budgetBlocked) holds.push("budget");
    if (company.status === "archived") holds.push("company_archived");
    if (company.status === "paused") holds.push("company_paused");
  }
  if (command === "abort") holds = [];
  if (command === "pause") holds = [...new Set([...holds, reason])];
  if (command === "resume") holds = holds.filter(hold => reason === "user" ? ["budget", "company_archived", "company_paused"].includes(hold) : hold !== reason);
  const blockingHolds = holds.filter(hold => hold !== "setup" || !["preparing", "verifying"].includes(agent.lifecycleState));
  let next = command === "reconcile"
    ? blockingHolds.length && !["pausing", "paused"].includes(agent.lifecycleState) ? "pausing" as const
      : !holds.length && agent.lifecycleState === "paused" ? "resuming" as const : agent.lifecycleState
    : command === "resume" && holds.length ? agent.lifecycleState
    : transition(agent.lifecycleState, command, agent.lifecycleOperation?.resumeState);
  if (restartPause && next === "paused") next = "pausing";
  if (command === "abort" && agent.lifecycleOperation?.hostComplete && agent.lifecycleRequiredPluginIds?.length) next = "resuming";
  if (command === "complete" && next === "ready" && holds.length) next = "pausing";
  if (command === "complete" && next === "paused" && !holds.length) next = "resuming";
  if (["complete", "reconcile"].includes(command) && next === "paused" && holds.length === 1 && holds[0] === "setup"
    && await effects.setupRequiresPreparation(tx, agent.companyId, agent.defaultEnvironmentId)) next = "preparing";
  if (next === agent.lifecycleState) {
    if (JSON.stringify(holds) !== JSON.stringify(agent.lifecycleHolds) || agent.pauseReason !== (holds[0] ?? null)) {
      const [updated] = await tx.update(agents).set({ lifecycleHolds: holds, pauseReason: holds[0] ?? null }).where(eq(agents.id, agent.id)).returning();
      return updated;
    }
    return agent;
  }
  const operation: AgentLifecycleOperation = {
    responsibleUserId: agent.lifecycleOperation?.responsibleUserId,
    id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0,
    resumeState: next === "pausing"
      ? agent.lifecycleState === "preparing" || agent.lifecycleState === "verifying" ? agent.lifecycleState : agent.lifecycleOperation?.resumeState ?? "ready"
      : agent.lifecycleOperation?.resumeState,
  };
  if (next === "ready") operation.resumeState = "ready";
  const status = compatibilityStatus(next, agent.status);
  if (status !== agent.status) await effects.beforeStatusChange(tx, agent.companyId, agent.id, agent.status, status);
  if (isLifecycleWorkPending(next)) await effects.notifyWork(tx);
  const [updated] = await tx.update(agents).set({
    lifecycleHolds: holds, lifecycleState: next, lifecycleVersion: agent.lifecycleVersion + 1, lifecycleError: null,
    lifecycleOperation: operation, status,
    pauseReason: holds[0] ?? null,
    pausedAt: next === "pausing" ? new Date() : next === "ready" ? null : agent.pausedAt,
    updatedAt: new Date(),
  }).where(eq(agents.id, agent.id)).returning();
  if (next === "terminating" || next === "rejected") {
    await tx.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.agentId, agent.id));
    await effects.clearPrimary(tx, agent.companyId, agent.id);
  }
  if (command === "approve") await effects.recordCreation(tx, agent.companyId, agent.id);
  if (next === "pausing" || next === "resuming" || next === "terminating" || next === "rejected") {
    await effects.recordStatus(tx, agent.companyId, agent.id,
      next === "resuming" ? "paused" : "idle",
      next === "resuming" ? "idle" : next === "pausing" ? "paused" : "terminated");
  }
  if (command === "abort" && next !== "resuming") await effects.recordStatus(tx, agent.companyId, agent.id, "paused", status);
  return updated;
}

/** Apply a computed hold without resolving policies or opening another transaction. */
export async function applyAgentPolicyHoldsInTransaction(tx: Db, effects: LifecycleEffects,
  companyId: string, agentId: string, patch: { budget?: boolean; companyStatus?: string; restartPause?: boolean }, lockedAgent?: LifecycleRow) {
  if (!("nestedIndex" in tx)) throw new AgentLifecycleConflict("Policy holds require the caller's accounting transaction");
  const agent = lockedAgent ?? (await tx.select().from(agents).where(and(
    eq(agents.id, agentId), eq(agents.companyId, companyId),
  )).for("update"))[0];
  if (!agent || agent.companyId !== companyId || ["pending_approval", "terminating", "cleaning_up", "terminated", "rejected"].includes(agent.lifecycleState)) return null;
  let holds = [...agent.lifecycleHolds];
  if (patch.budget !== undefined) {
    holds = holds.filter(hold => hold !== "budget");
    if (patch.budget) holds.push("budget");
  }
  if (patch.companyStatus !== undefined) {
    holds = holds.filter(hold => hold !== "company_paused" && hold !== "company_archived");
    if (patch.companyStatus === "paused") holds.push("company_paused");
    if (patch.companyStatus === "archived") holds.push("company_archived");
  }
  return changeLockedAgent(tx, effects, agent, "reconcile", {}, holds, patch.restartPause);
}

export function createLifecycleStore(db: Db, effects: LifecycleEffects): LifecycleStore {
  const get = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0] ?? null);
  return {
    get,
    async change(id, command, options = {}) {
      const existing = await get(id);
      if (!existing) return null;
      return effects.transaction(db, existing.companyId, async tx => {
        const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update", command === "reconcile" ? { skipLocked: true } : undefined);
        if (!agent) return null;
        return changeLockedAgent(tx, effects, agent, command, options);
      });
    },
    async claim(id, owner, now) {
      const [agent] = await db.update(agents).set({
        lifecycleOperation: sql`coalesce(${agents.lifecycleOperation}, '{"id":"", "hostComplete":false, "completedPluginIds":[], "attempts":0}'::jsonb)
          || jsonb_build_object('leaseOwner', ${owner}::text, 'leaseUntil', ${(new Date(now.getTime() + 120_000)).toISOString()}::text,
            'attempts', coalesce((${agents.lifecycleOperation}->>'attempts')::integer, 0) + 1)`,
      }).where(and(eq(agents.id, id), pendingLifecycleWork,
        sql`(${agents.lifecycleState} in ('pausing', 'terminating', 'cleaning_up') or exists (
          select 1 from ${companies} where ${companies.id} = ${agents.companyId} and ${companies.status} = 'active'))`,
        sql`coalesce((${agents.lifecycleOperation}->>'leaseUntil')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
        sql`coalesce((${agents.lifecycleOperation}->>'retryAt')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
      )).returning();
      return agent ?? null;
    },
    async renew(agent, owner, now) {
      const rows = await db.update(agents).set({ lifecycleOperation: sql`jsonb_set(${agents.lifecycleOperation}, '{leaseUntil}', ${JSON.stringify(new Date(now.getTime() + 120_000).toISOString())}::jsonb)` })
        .where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion), sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async setRequiredPlugins(agent, owner, pluginIds) {
      const rows = await db.update(agents).set({ lifecycleRequiredPluginIds: pluginIds })
        .where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
          sql`${agents.lifecycleRequiredPluginIds} is null`,
          sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async completeHost(agent, owner) {
      const rows = await db.update(agents).set({
        lifecycleOperation: sql`jsonb_set(${agents.lifecycleOperation}, '{hostComplete}', 'true'::jsonb)`,
      }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
        sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async completePlugin(agent, owner, pluginId) {
      const rows = await db.update(agents).set({
        lifecycleOperation: sql`jsonb_set(${agents.lifecycleOperation}, '{completedPluginIds}',
          coalesce(${agents.lifecycleOperation}->'completedPluginIds', '[]'::jsonb) || ${JSON.stringify([pluginId])}::jsonb)`,
      }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
        sql`${agents.lifecycleRequiredPluginIds} @> ${JSON.stringify([pluginId])}::jsonb`,
        sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async defer(agent, owner, error, now, options) {
      const rows = await db.update(agents).set({
        ...(error === undefined ? {} : { lifecycleError: error }),
        lifecycleOperation: sql`(${agents.lifecycleOperation} - 'leaseOwner' - 'leaseUntil')
          || jsonb_build_object('retryAt', ${new Date(now.getTime() + (options?.retryInMs ?? (error ? 60_000 : 2_000))).toISOString()}::text)`,
        updatedAt: now,
      }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
        sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async pending(limit, now) {
      return db.select({ id: agents.id }).from(agents).where(and(
        pendingLifecycleWork,
        sql`coalesce((${agents.lifecycleOperation}->>'leaseUntil')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
        sql`coalesce((${agents.lifecycleOperation}->>'retryAt')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
      )).orderBy(asc(agents.updatedAt), asc(agents.id)).limit(limit).then(rows => rows.map(row => row.id));
    },
  };
}
