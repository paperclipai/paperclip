import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agents, agentApiKeys, companies, budgetPolicies, type Db } from "@paperclipai/db";
import type { AgentLifecycleOperation } from "@paperclipai/shared";
import { withAccountingTransaction } from "../../../services/accounting-transaction.js";
import { clearPrimaryAgent } from "../../../services/primary-agent.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "../../../services/resource-lifecycle-events.js";
import { AgentLifecycleConflict, compatibilityStatus, transition } from "../domain/policy.js";
import { policyBlocks } from "../../../services/budgets.js";
import type { LifecycleStore } from "../application/ports.js";

export function assertRootDatabase(db: Db) {
  if ("nestedIndex" in db) throw new AgentLifecycleConflict("Lifecycle commands require the root database connection");
}

export function createLifecycleStore(db: Db): LifecycleStore {
  const get = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0] ?? null);
  return {
    get,
    async change(id, command, options = {}) {
      const existing = await get(id);
      if (!existing) return null;
      return withAccountingTransaction(db, existing.companyId, async tx => {
        const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update", command === "reconcile" ? { skipLocked: true } : undefined);
        if (!agent) return null;
        if (options.version !== undefined && options.version !== agent.lifecycleVersion) return null;
        if (command === "complete" && (!options.owner || !agent.lifecycleOperation?.leaseUntil || agent.lifecycleOperation?.leaseOwner !== options.owner ||
          Date.parse(agent.lifecycleOperation?.leaseUntil ?? "") <= Date.now() ||
          !agent.lifecycleOperation?.participants.length ||
          agent.lifecycleOperation.participants.some(id => !agent.lifecycleOperation!.completed.includes(id)))) return null;
        if (command === "retry") {
          transition(agent.lifecycleState, command);
          if (agent.lifecycleOperation?.leaseUntil && Date.parse(agent.lifecycleOperation.leaseUntil) > Date.now()) return agent;
          const [updated] = await tx.update(agents).set({ lifecycleError: null,
            lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt' - 'leaseOwner' - 'leaseUntil'`, updatedAt: new Date() }).where(eq(agents.id, id)).returning();
          return updated;
        }
        if (command === "resume" && !["ready", "paused", "pausing", "resuming"].includes(agent.lifecycleState)) transition(agent.lifecycleState, command);
        let holds = agent.lifecycleHolds;
        const reason = options.reason ?? "manual";
        if (command === "reconcile") {
          if (["pending_approval", "terminating", "cleaning_up", "terminated", "rejected"].includes(agent.lifecycleState)) return agent;
          const [company] = await tx.select().from(companies).where(eq(companies.id, agent.companyId));
          const policies = await tx.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, agent.companyId),
            eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, id)));
          let budgetBlocked = false;
          for (const policy of policies) if (await policyBlocks(tx, policy)) budgetBlocked = true;
          holds = holds.filter(hold => hold !== "budget" && hold !== "company_archived" && hold !== "company_paused");
          if (budgetBlocked) holds.push("budget");
          if (company.status === "archived") holds.push("company_archived");
          if (company.status === "paused") holds.push("company_paused");
        }
        if (command === "pause") holds = [...new Set([...holds, reason])];
        if (command === "resume") holds = holds.filter(hold => reason === "user" ? ["budget", "company_archived", "company_paused"].includes(hold) : hold !== reason);
        let next = command === "reconcile"
          ? holds.length && !["pausing", "paused"].includes(agent.lifecycleState) ? "pausing" as const
            : !holds.length && agent.lifecycleState === "paused" ? "resuming" as const : agent.lifecycleState
          : command === "resume" && (holds.length || agent.lifecycleState === "pausing") ? agent.lifecycleState
          : transition(agent.lifecycleState, command, agent.lifecycleOperation?.resumeState);
        if (command === "complete" && next === "ready" && holds.length) next = "pausing";
        if (command === "complete" && next === "paused" && !holds.length) next = "resuming";
        if (next === agent.lifecycleState) {
          if (JSON.stringify(holds) !== JSON.stringify(agent.lifecycleHolds) || agent.pauseReason !== (holds[0] ?? null)) {
            await tx.update(agents).set({ lifecycleHolds: holds, pauseReason: holds[0] ?? null }).where(eq(agents.id, id));
          }
          return agent;
        }
        const operation: AgentLifecycleOperation = {
          responsibleUserId: agent.lifecycleOperation?.responsibleUserId,
          id: randomUUID(), participants: options.participants ?? [], completed: [], attempts: 0,
          resumeState: next === "pausing"
            ? agent.lifecycleState === "preparing" || agent.lifecycleState === "verifying" ? agent.lifecycleState : agent.lifecycleOperation?.resumeState ?? "ready"
            : agent.lifecycleOperation?.resumeState,
        };
        if (next === "ready") operation.resumeState = "ready";
        const status = compatibilityStatus(next, agent.status);
        const [updated] = await tx.update(agents).set({
          lifecycleHolds: holds, lifecycleState: next, lifecycleVersion: agent.lifecycleVersion + 1, lifecycleError: null,
          lifecycleOperation: operation, status,
          pauseReason: holds[0] ?? null,
          pausedAt: next === "pausing" ? new Date() : next === "ready" ? null : agent.pausedAt,
          updatedAt: new Date(),
        }).where(eq(agents.id, id)).returning();
        if (next === "terminating" || next === "rejected") {
          await tx.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.agentId, id));
          await clearPrimaryAgent(tx, agent.companyId, id);
        }
        if (command === "approve") await recordResourceCreationEvent(tx, agent.companyId, "agent", id);
        if (next === "pausing" || next === "resuming" || next === "terminating" || next === "rejected") {
          await recordAgentStatusEvent(tx, agent.companyId, id,
            next === "resuming" ? "paused" : "idle",
            next === "resuming" ? "idle" : next === "pausing" ? "paused" : "terminated");
        }
        return updated;
      });
    },
    async claim(id, owner, now) {
      const [agent] = await db.update(agents).set({
        lifecycleOperation: sql`coalesce(${agents.lifecycleOperation}, '{"id":"", "participants":[], "completed":[], "attempts":0}'::jsonb)
          || jsonb_build_object('leaseOwner', ${owner}::text, 'leaseUntil', ${(new Date(now.getTime() + 120_000)).toISOString()}::text,
            'attempts', coalesce((${agents.lifecycleOperation}->>'attempts')::integer, 0) + 1)`,
      }).where(and(eq(agents.id, id), inArray(agents.lifecycleState, ["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"]),
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
    async setParticipants(agent, owner, participants) {
      const rows = await db.update(agents).set({
        lifecycleParticipants: participants.filter(id => id !== "host"),
        lifecycleOperation: sql`jsonb_set(${agents.lifecycleOperation}, '{participants}', ${JSON.stringify(participants)}::jsonb)`,
      }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
        sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async recordResult(agent, owner, participant, error, now) {
      const release = error !== null || participant === "";
      const rows = await db.update(agents).set({
        lifecycleError: error,
        lifecycleOperation: release
          ? sql`(${agents.lifecycleOperation} - 'leaseOwner' - 'leaseUntil') || jsonb_build_object('retryAt', ${new Date(now.getTime() + (error ? 60_000 : 2_000)).toISOString()}::text)`
          : sql`jsonb_set(${agents.lifecycleOperation}, '{completed}', coalesce(${agents.lifecycleOperation}->'completed', '[]'::jsonb) || ${JSON.stringify([participant])}::jsonb)`,
        updatedAt: now,
      }).where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
        sql`${agents.lifecycleOperation}->>'leaseOwner' = ${owner}`)).returning({ id: agents.id });
      return rows.length > 0;
    },
    async pending(limit, now) {
      return db.select({ id: agents.id }).from(agents).where(and(
        inArray(agents.lifecycleState, ["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"]),
        sql`coalesce((${agents.lifecycleOperation}->>'leaseUntil')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
        sql`coalesce((${agents.lifecycleOperation}->>'retryAt')::timestamptz, '-infinity') <= ${now.toISOString()}::timestamptz`,
      )).orderBy(asc(agents.updatedAt), asc(agents.id)).limit(limit).then(rows => rows.map(row => row.id));
    },
  };
}
