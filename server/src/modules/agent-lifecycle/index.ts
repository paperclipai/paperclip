import { approvalService as approvalRecords } from "./adapters/approvals.js";
import { dotInvitationService as invitationRecords } from "./adapters/dot-invitations.js";
import { onboardingSeedService as seedRecords } from "./adapters/onboarding-seed.js";
import { trackIdleWork } from "../../services/task-admission.js";
import { deleteCompany } from "./adapters/delete-company.js";
import { createLifecycleDriver } from "./adapters/driver.js";
import type { PluginWorkerManager } from "../../services/plugin-worker-manager.js";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { BudgetServiceHooks } from "../../services/budgets.js";
import { agentRecords } from "./adapters/records.js";
import { assertRootDatabase, createLifecycleStore } from "./adapters/postgres.js";
import { createLifecycleWorker } from "./application/worker.js";
import type { LifecycleDriver } from "./application/ports.js";

export { AgentLifecycleConflict, canConfigureAgentConnection } from "./domain/policy.js";
export { hasAgentShortnameCollision, deduplicateAgentName } from "./adapters/records.js";
export type { LifecycleDriver, LifecycleAgent } from "./application/ports.js";

const workers = new WeakMap<Db, ReturnType<typeof createLifecycleWorker>>();
export function configureAgentLifecycle(db: Db, driver: LifecycleDriver, canRun = () => true) {
  assertRootDatabase(db);
  const worker = createLifecycleWorker(createLifecycleStore(db), {
    ...driver,
    run: (agent, participant) => trackIdleWork(driver.run(agent, participant)),
  }, canRun);
  workers.set(db, worker);
  return worker;
}
function kick(db: Db, id: string) {
  // The periodic sweep retries work if the process stops before this call.
  void workers.get(db)?.process(id).catch(() => {});
}

export function agentConfiguration(db: Db, hooks: BudgetServiceHooks = {}) {
  const { create, rejectPendingHire, remove, activatePendingApproval, updateAndTransition, ...configuration } = agentRecords(db, hooks);
  return configuration;
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}) {
  assertRootDatabase(db);
  const records = agentRecords(db, hooks);
  const store = createLifecycleStore(db);
  async function change(id: string, command: "pause" | "resume" | "terminate" | "reject" | "retry", reason?: string) {
    const result = await store.change(id, command, { reason });
    if (result) kick(db, id);
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
      kick(db, agent.id);
      return agent;
    },
    async approveHire(...args: Parameters<typeof records.activatePendingApproval>) {
      const result = await records.activatePendingApproval(...args);
      if (result?.activated) kick(db, result.agent.id);
      return result;
    },
    rejectHire: (id: string) => change(id, "reject"),
    async updateAndTransition(...args: Parameters<typeof records.updateAndTransition>) {
      const agent = await records.updateAndTransition(...args);
      if (agent) kick(db, agent.id);
      return agent;
    },
    pauseAgent: (id: string, reason = "manual") => change(id, "pause", reason),
    resumeAgent: (id: string, reason = "user") => change(id, "resume", reason),
    terminateAgent: (id: string) => change(id, "terminate"),
    retry: (id: string) => change(id, "retry"),
    purgeAgent: records.remove,
  };
}

export { parseSeedMission } from "./adapters/onboarding-seed.js";
export type { OnboardingSeedApplication, OnboardingSeedAuditActor } from "./adapters/onboarding-seed.js";

export function approvalService(db: Db) {
  assertRootDatabase(db);
  const records = approvalRecords(db);
  return { ...records, async approve(...args: Parameters<typeof records.approve>) {
    const result = await records.approve(...args);
    if (result.hireApprovedAgentId) kick(db, result.hireApprovedAgentId);
    return { approval: result.approval, applied: result.applied };
  } };
}
export function dotInvitationService(db: Db) {
  assertRootDatabase(db);
  const records = invitationRecords(db);
  return { ...records, async create(...args: Parameters<typeof records.create>) {
    const result = await records.create(...args);
    kick(db, result.agent.id);
    return result;
  } };
}
export function onboardingSeedService(db: Db) {
  assertRootDatabase(db);
  const records = seedRecords(db);
  return { ...records, async apply(...args: Parameters<typeof records.apply>) {
    const result = await records.apply(...args);
    if (result.agentId) kick(db, result.agentId);
    return result;
  } };
}

export async function reconcileAgentPolicyHolds(db: Db, companyId?: string, agentId?: string | null) {
  assertRootDatabase(db);
  if (agentId === null) return;
  const store = createLifecycleStore(db);
  const rows = await db.select({ id: agents.id }).from(agents).where(and(
    companyId ? eq(agents.companyId, companyId) : undefined, agentId ? eq(agents.id, agentId) : undefined,
  ));
  for (const row of rows) {
    await store.change(row.id, "reconcile");
    kick(db, row.id);
  }
}

export function startAgentLifecycle(db: Db, manager: PluginWorkerManager, canRun: () => boolean) {
  const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), canRun);
  let running: Promise<void> | undefined;
  let stopped = false;
  let nextPolicySweep = 0;
  function sweep() {
    if (stopped || !canRun()) return Promise.resolve();
    return running ??= (async () => {
      if (Date.now() >= nextPolicySweep) {
        await reconcileAgentPolicyHolds(db);
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

export async function deleteCompanyWithAgents(db: Db, companyId: string) {
  const lifecycle = createAgentLifecycle(db);
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
  for (const row of rows) {
    await lifecycle.terminateAgent(row.id);
    await workers.get(db)?.process(row.id);
  }
  return deleteCompany(db, companyId);
}
