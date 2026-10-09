import { hireApprovalService as approvalRecords } from "./adapters/approvals.js";
export { deleteTerminatedCompanyAgents } from "./adapters/delete-company.js";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { LifecycleEffects } from "./adapters/effects.js";
export type { LifecycleEffects } from "./adapters/effects.js";
import { agentRecords } from "./adapters/records.js";
import { assertRootDatabase, createLifecycleStore } from "./adapters/postgres.js";
import { createLifecycleWorker } from "./application/worker.js";
import type { LifecycleDriver } from "./application/ports.js";

export { AgentLifecycleConflict, canConfigureAgentConnection } from "./domain/policy.js";

export type { LifecycleDriver, LifecycleAgent } from "./application/ports.js";

const workers = new WeakMap<Db, ReturnType<typeof createLifecycleWorker>>();
export function configureAgentLifecycle(db: Db, effects: LifecycleEffects, driver: LifecycleDriver, canRun = () => true) {
  assertRootDatabase(db);
  const worker = createLifecycleWorker(createLifecycleStore(db, effects), driver, canRun);
  workers.set(db, worker);
  return worker;
}
export function scheduleAgentLifecycle(db: Db, id: string) {
  // The periodic sweep retries work if the process stops before this call.
  void workers.get(db)?.process(id).catch(() => {});
}

/** Configuration changes can share their credential transaction; transitions cannot. */
export function updateAgentConfiguration(db: Db, effects: LifecycleEffects,
  ...args: Parameters<ReturnType<typeof agentRecords>["update"]>) {
  return agentRecords(db, effects).update(...args);
}

export function createAgentLifecycle(db: Db, effects: LifecycleEffects) {
  assertRootDatabase(db);
  const records = agentRecords(db, effects);
  const store = createLifecycleStore(db, effects);
  async function change(id: string, command: "pause" | "resume" | "terminate" | "reject" | "retry", reason?: string) {
    const result = await store.change(id, command, { reason });
    if (result) scheduleAgentLifecycle(db, id);
    return result ? records.getById(id) : null;
  }
  return {
    async get(id: string) {
      const agent = await store.get(id);
      return agent ? {
        id: agent.id, companyId: agent.companyId, lifecycleState: agent.lifecycleState,
        lifecycleVersion: agent.lifecycleVersion, lifecycleError: agent.lifecycleError,
      } : null;
    },
    async requestHire(...args: Parameters<typeof records.create>) {
      const agent = await records.create(...args);
      scheduleAgentLifecycle(db, agent.id);
      return agent;
    },
    async approveHire(...args: Parameters<typeof records.activatePendingApproval>) {
      const result = await records.activatePendingApproval(...args);
      if (result?.activated) scheduleAgentLifecycle(db, result.agent.id);
      return result;
    },
    rejectHire: (id: string) => change(id, "reject"),
    async updateAndTransition(...args: Parameters<typeof records.updateAndTransition>) {
      const agent = await records.updateAndTransition(...args);
      if (agent) scheduleAgentLifecycle(db, agent.id);
      return agent;
    },
    pauseAgent: (id: string, reason = "manual") => change(id, "pause", reason),
    resumeAgent: (id: string, reason = "user") => change(id, "resume", reason),
    terminateAgent: (id: string) => change(id, "terminate"),
    retry: (id: string) => change(id, "retry"),
    clearError: records.clearError,
    purgeAgent: records.remove,
  };
}

export async function resolveAgentHireApproval(db: Db, effects: LifecycleEffects, id: string, status: "approved" | "rejected", userId: string, note?: string | null) {
  assertRootDatabase(db);
  const records = approvalRecords(db, effects);
  if (status === "rejected") return { ...await records.reject(id, userId, note), hireApprovedAgentId: null };
  const result = await records.approve(id, userId, note);
  if (result.hireApprovedAgentId) scheduleAgentLifecycle(db, result.hireApprovedAgentId);
  return result;
}
export async function reconcileAgentPolicyHolds(db: Db, effects: LifecycleEffects, companyId?: string, agentId?: string | null) {
  assertRootDatabase(db);
  if (agentId === null) return;
  const store = createLifecycleStore(db, effects);
  const rows = await db.select({ id: agents.id }).from(agents).where(and(
    companyId ? eq(agents.companyId, companyId) : undefined, agentId ? eq(agents.id, agentId) : undefined,
  ));
  for (const row of rows) {
    await store.change(row.id, "reconcile");
    scheduleAgentLifecycle(db, row.id);
  }
}

export function startAgentLifecycle(db: Db, effects: LifecycleEffects, driver: LifecycleDriver, canRun: () => boolean) {
  const worker = configureAgentLifecycle(db, effects, driver, canRun);
  let running: Promise<void> | undefined;
  let stopped = false;
  let nextPolicySweep = 0;
  function sweep() {
    if (stopped || !canRun()) return Promise.resolve();
    return running ??= (async () => {
      if (Date.now() >= nextPolicySweep) {
        await reconcileAgentPolicyHolds(db, effects);
        nextPolicySweep = Date.now() + 60_000;
      }
      await worker.sweep();
    })().finally(() => { running = undefined; });
  }
  const timer = setInterval(() => { void sweep().catch(() => {}); }, 5_000);
  timer.unref?.();
  return {
    sweep,
    async stop() {
      stopped = true;
      clearInterval(timer);
      workers.delete(db);
      try { await running; } finally { await worker.stop(); }
    },
  };
}

export async function terminateCompanyAgents(db: Db, effects: LifecycleEffects, companyId: string) {
  const lifecycle = createAgentLifecycle(db, effects);
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
  for (const row of rows) {
    await lifecycle.terminateAgent(row.id);
    await workers.get(db)?.process(row.id);
  }

}
