import { hireApprovalService as approvalRecords, type HireDecisionTarget } from "./adapters/approvals.js";
import { agents, companies } from "@paperclipai/db";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { LifecycleEffects } from "./adapters/effects.js";
export type { LifecycleEffects } from "./adapters/effects.js";
import { updateAgentConfiguration } from "./adapters/configuration.js";
import type { AgentConfigurationPatch, UpdateAgentOptions } from "../../lib/agent-records.js";
import { purgeAgent } from "./adapters/deletion.js";
import { agentRecords } from "./adapters/records.js";
import { assertRootDatabase, createLifecycleStore, pendingLifecycleWork, lifecycleSignalWait, requestAgentLifecycleRecheckInTransaction } from "./adapters/postgres.js";
import { hasCompanyHoldMismatch, projectCompanyHolds } from "./adapters/company-policy.js";
import { createLifecycleWorker } from "./application/worker.js";
import type { LifecycleDriver } from "./application/ports.js";

export { applyAgentPolicyHoldsInTransaction, requestAgentLifecycleRecheckInTransaction } from "./adapters/postgres.js";
export { companyHoldMismatch, fenceActiveCompanyAgentStopsInTransaction } from "./adapters/company-policy.js";

export { AgentLifecycleConflict, canConfigureAgentConnection, isAgentAwaitingSetup, isAgentSetupDraft } from "./domain/policy.js";

export type { HireDecisionTarget } from "./adapters/approvals.js";
export type { LifecycleDriver, LifecycleAgent, LifecycleFailure } from "./application/ports.js";

const wakes = new WeakMap<Db, () => void>();

const workers = new WeakMap<Db, ReturnType<typeof createLifecycleWorker>>();
export function configureAgentLifecycle(db: Db, effects: LifecycleEffects, driver: LifecycleDriver, canRun = () => true) {
  assertRootDatabase(db);
  const worker = createLifecycleWorker(createLifecycleStore(db, effects), driver, effects.reportFailure, canRun);
  workers.set(db, worker);
  return worker;
}
export function scheduleAgentLifecycle(db: Db, id: string) {
  const wake = wakes.get(db);
  if (wake) { wake(); return; }
  // Standalone/test owners may explicitly configure a worker without a coordinator.
  return workers.get(db)?.process(id).catch(() => {});
}

/** Destructive deletion must establish this agent's completed cleanup before
 * purging dependent records. Ordinary producers only schedule asynchronous work. */
export function processAgentLifecycle(db: Db, id: string): Promise<void> {
  return workers.get(db)?.process(id) ?? Promise.resolve();
}

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
    async updateConfiguration(id: string, data: AgentConfigurationPatch, options?: UpdateAgentOptions) {
      const existing = await records.getById(id);
      if (!existing) return null;
      const agent = await effects.transaction(db, existing.companyId, (tx, publications) =>
        updateAgentConfiguration(tx, effects, id, data, options, publications));
      scheduleAgentLifecycle(db, id);
      return agent;
    },
    async updateAndTransition(id: string, command: "pause" | "resume" | "terminate", data: AgentConfigurationPatch, options?: UpdateAgentOptions) {
      const existing = await records.getById(id);
      if (!existing) return null;
      const agent = await effects.transaction(db, existing.companyId, async (tx, publications) => {
        await updateAgentConfiguration(tx, effects, id, data, options, publications);
        await createLifecycleStore(tx, effects).change(id, command, { reason: command === "resume" ? "user" : "manual" });
        return agentRecords(tx, effects).getById(id);
      });
      scheduleAgentLifecycle(db, id);
      return agent;
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
  let nextDeadline: number | null = null;
  const recoveryStartedAt = new Date();
  let recoveryInitialized = false, recoveryDone = false;
  let recoveryThrough: string | undefined, recoveryAfter: string | undefined;
  let recoveryInitialization: Promise<void> | undefined;
  const recoveryCondition = and(lifecycleSignalWait, lte(agents.createdAt, recoveryStartedAt));
  async function initializeRecovery() {
    if (recoveryInitialized) return;
    return recoveryInitialization ??= (async () => {
      const [last] = await db.select({ id: agents.id }).from(agents).where(recoveryCondition)
        .orderBy(desc(agents.id)).limit(1);
      recoveryThrough = last?.id; recoveryDone = !last; recoveryInitialized = true;
    })().catch(error => { recoveryInitialization = undefined; throw error; });
  }
  async function recoverPage() {
    await initializeRecovery();
    if (recoveryDone || !recoveryThrough) return;
    const page = await db.select({ id: agents.id, companyId: agents.companyId, version: agents.lifecycleVersion })
      .from(agents).innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(recoveryCondition, eq(companies.status, "active"), lte(agents.id, recoveryThrough),
        recoveryAfter ? gt(agents.id, recoveryAfter) : undefined)).orderBy(asc(agents.id)).limit(100);
    for (const agent of page) {
      if (stopped || !canRun()) return;
      await effects.transaction(db, agent.companyId, tx => requestAgentLifecycleRecheckInTransaction(tx,
        { companyId: agent.companyId, agentId: agent.id, expectedVersion: agent.version, onlyIfWaiting: true },
        () => effects.notifyWork(tx)));
      recoveryAfter = agent.id;
    }
    if (page.length < 100) recoveryDone = true;
  }
  // The coordinator supplies the wake after construction. No direct work escapes it.
  wakes.set(db, () => {});
  return {
    setWake(wake: () => void) { wakes.set(db, wake); },
    nextRunAt: () => nextDeadline,
    async hasPending() {
      if (stopped) { nextDeadline = null; return false; }
      if (canRun()) {
        await initializeRecovery();
        if (!recoveryDone) return true;
      }
      const [pending] = await db.select({ due: sql<number | null>`min(greatest(
        coalesce(extract(epoch from (${agents.lifecycleOperation}->>'leaseUntil')::timestamptz) * 1000, 0),
        coalesce(extract(epoch from (${agents.lifecycleOperation}->>'retryAt')::timestamptz) * 1000, 0)))::double precision` })
        .from(agents).where(pendingLifecycleWork);
      const due = pending?.due == null ? null : Number(pending.due);
      const now = Date.now();
      // Already-due work uses the coordinator's bounded retry. A zero-delay
      // deadline would spin if plugins are not ready to process it yet.
      nextDeadline = due !== null && due > now ? due : null;
      return (due !== null && due <= now) || await hasCompanyHoldMismatch(db);
    },
    sweep() {
      if (stopped || !canRun()) return Promise.resolve();
      return running ??= (async () => {
        try { await projectCompanyHolds(db, effects); }
        catch (error) { effects.reportFailure({ stage: "policy_scan" }, error); throw error; }
        try { await recoverPage(); }
        catch (error) { effects.reportFailure({ stage: "scan" }, error); throw error; }
        await worker.sweep();
      })().finally(() => { running = undefined; });
    },
    async stop() {
      stopped = true;
      wakes.delete(db);
      workers.delete(db);
      try { await running; } finally { await worker.stop(); }
    },
  };
}

export { lifecycleFailureCode } from "./application/failure.js";
