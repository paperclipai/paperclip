import { hireApprovalService as approvalRecords, type HireDecisionTarget } from "./adapters/approvals.js";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { LifecycleEffects } from "./adapters/effects.js";
export type { LifecycleEffects } from "./adapters/effects.js";
import { purgeAgent } from "./adapters/deletion.js";
import { agentRecords } from "./adapters/records.js";
import { assertRootDatabase, createLifecycleStore } from "./adapters/postgres.js";
import { createLifecycleWorker } from "./application/worker.js";
import type { LifecycleDriver } from "./application/ports.js";

export { AgentLifecycleConflict, canConfigureAgentConnection, isAgentAwaitingSetup } from "./domain/policy.js";

export type { HireDecisionTarget } from "./adapters/approvals.js";
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
  return workers.get(db)?.process(id).catch(() => {});
}

// Only configuration persistence can invalidate verification inside its transaction.
export { invalidateAgentVerification } from "./adapters/configuration.js";

export function createAgentLifecycle(db: Db, effects: LifecycleEffects) {
  assertRootDatabase(db);
  const records = agentRecords(db, effects);
  const store = createLifecycleStore(db, effects);
  async function change(id: string, command: "pause" | "resume" | "terminate" | "retry", reason?: string) {
    const result = await store.change(id, command, { reason });
    if (result) scheduleAgentLifecycle(db, id);
    return result ? records.getById(id) : null;
  }
  async function decideHire(target: HireDecisionTarget, decision: "approved" | "rejected", userId: string, note?: string | null) {
    const result = await approvalRecords(db, effects).decide(target, decision, userId, note);
    if (result?.hireApprovedAgentId) scheduleAgentLifecycle(db, result.hireApprovedAgentId);
    return result;
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
    approveHire: (target: HireDecisionTarget, userId = "board", note?: string | null) => decideHire(target, "approved", userId, note),
    rejectHire: (target: HireDecisionTarget, userId = "board", note?: string | null) => decideHire(target, "rejected", userId, note),
    async updateAndTransition(id: string, command: "pause" | "resume" | "terminate", data: Parameters<LifecycleEffects["updateConfiguration"]>[2], options?: Parameters<LifecycleEffects["updateConfiguration"]>[3]) {
      const existing = await records.getById(id);
      if (!existing) return null;
      const agent = await effects.transaction(db, existing.companyId, async (tx, publications) => {
        await effects.updateConfiguration(tx, id, data, options, publications);
        await createLifecycleStore(tx, effects).change(id, command, { reason: command === "resume" ? "user" : "manual" });
        return agentRecords(tx, effects).getById(id);
      });
      if (data.budgetMonthlyCents !== undefined) await effects.enforceBudget(db, existing.companyId);
      scheduleAgentLifecycle(db, id);
      return agent;
    },
    async reconcilePolicyHolds(companyId?: string, agentId?: string | null) {
      if (agentId === null) return;
      const rows = await db.select({ id: agents.id }).from(agents).where(and(
        companyId ? eq(agents.companyId, companyId) : undefined, agentId ? eq(agents.id, agentId) : undefined,
      ));
      for (const row of rows) {
        await store.change(row.id, "reconcile");
        scheduleAgentLifecycle(db, row.id);
      }
    },
    pauseAgent: (id: string, reason = "manual") => change(id, "pause", reason),
    resumeAgent: (id: string, reason = "user") => change(id, "resume", reason),
    terminateAgent: (id: string) => change(id, "terminate"),
    retry: (id: string) => change(id, "retry"),
    clearError: records.clearError,
    purgeAgent: (id: string) => purgeAgent(db, effects, id),
  };
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
        await createAgentLifecycle(db, effects).reconcilePolicyHolds();
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
