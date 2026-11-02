import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, applyPendingMigrations, heartbeatRuns, museRunnerAssignments, museAgentBindings } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { startMuseMaintenance } from "./muse-maintenance.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { idleWorkSnapshot } from "./task-admission.js";

const effects = vi.hoisted(() => ({
  endQualification: vi.fn(), revokeOAuthGrant: vi.fn(), reconcileTerminalAssignments: vi.fn(),
  start: vi.fn(), stop: vi.fn(),
}));
vi.mock("./muse-runner-broker.js", () => ({ museRunnerBroker: () => effects }));
vi.mock("./muse-receiver.js", () => ({ museReceiver: () => effects }));
const externalUrl = process.env.PAPERCLIP_MUSE_MAINTENANCE_TEST_DATABASE_URL;
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("Muse commit and deadline maintenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let stop: ReturnType<typeof startMuseMaintenance>;
  let enabled: boolean;
  let draining: boolean;
  let calls: string[];
  let errors: unknown[];
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else database = await startEmbeddedPostgresTestDatabase("muse-maintenance-");
    db = createDb(externalUrl ?? database.connectionString, { maxConnections: 3 });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    enabled = true; draining = false; calls = []; errors = [];
    effects.stop.mockResolvedValue(undefined);
    effects.reconcileTerminalAssignments.mockResolvedValue(undefined);
    effects.revokeOAuthGrant.mockResolvedValue(undefined);
    effects.endQualification.mockImplementation(async ({ bindingId }) => {
      await db.update(museAgentBindings).set({ revokedAt: new Date() }).where(eq(museAgentBindings.id, bindingId));
    });
  });
  afterEach(async () => {
    await coordinator?.stop();
    await stop?.();
    vi.useRealTimers();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(expiresAt: Date | null = null) {
    const [company] = await db.insert(companies).values({ name: "Maintenance", issuePrefix: `MT${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Muse agent" }).returning();
    const [binding] = await db.insert(museAgentBindings).values({ companyId: company.id, agentId: agent.id,
      operatorId: "synthetic-operator", qualificationId: expiresAt ? randomUUID() : null, qualificationExpiresAt: expiresAt }).returning();
    return binding;
  }
  async function start(failFirstUpdate = false) {
    const observed = new Proxy(db, { get(target, key) {
      if (!["select", "update", "insert", "delete", "execute", "transaction"].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls.push(String(key));
        if (key === "update" && failFirstUpdate) { failFirstUpdate = false; throw new Error("temporary DB failure"); }
        return Reflect.apply(Reflect.get(target, key), target, args);
      };
    } });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled && !draining,
      canReconcile: () => enabled, onError: error => errors.push(error) });
    stop = startMuseMaintenance(observed, coordinator);
    await stop.ready;
  }
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  async function signalWrite(bindingId: string, at: Date) {
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance);
      await tx.update(museAgentBindings).set({ qualificationId: randomUUID(), qualificationExpiresAt: at })
        .where(eq(museAgentBindings.id, bindingId));
    });
  }

  it("stays SQL-quiet after startup with no bindings, including during drain", async () => {
    await start();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(600_000);
    draining = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual(baseline);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("does not poll an idle configured binding", async () => {
    await fixture(); await start();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual(baseline);
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
  });
  it("waits for outer commit, then enforces a newly saved deadline without polling", async () => {
    const binding = await fixture(); await start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let written!: () => void;
    const ready = new Promise<void>(resolve => { written = resolve; });
    const at = new Date(Date.now() + 60_000);
    const transaction = db.transaction(async tx => {
      await tx.transaction(async nested => {
        await notifyDeliveryWork(nested, DELIVERY_QUEUES.museMaintenance);
        await nested.update(museAgentBindings).set({ qualificationId: randomUUID(), qualificationExpiresAt: at })
          .where(eq(museAgentBindings.id, binding.id));
      });
      written(); await gate;
    });
    await ready;
    expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
    release(); await transaction; await settle();
    expect(coordinator.nextWakeAt()).toBe(at.getTime());
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toEqual(baseline);
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(effects.endQualification).toHaveBeenCalledWith(expect.objectContaining({ bindingId: binding.id }));
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("recovers a rolled-back intent without leaving an empty timer", async () => {
    const binding = await fixture(); await start();
    await expect(db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance);
      await tx.update(museAgentBindings).set({ qualificationExpiresAt: new Date(), qualificationId: randomUUID() }).where(eq(museAgentBindings.id, binding.id));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await settle();
    expect(effects.endQualification).not.toHaveBeenCalled();
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("does not poll a running Muse assignment waiting for a real event", async () => {
    const b = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: b.companyId, agentId: b.agentId,
      invocationSource: "automation", status: "running" }).returning();
    await db.insert(museRunnerAssignments).values({ companyId: b.companyId,
      agentId: b.agentId, bindingId: b.id, bindingGeneration: b.generation, runId: run.id,
      normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1,
      catalogDigest: "test", status: "accepted", projection: {}, acceptBy: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await start();
    expect(coordinator.nextWakeAt()).toBeNull();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual(baseline);
  });

  it("retries a terminal assignment only until its concrete settlement completes", async () => {
    const b = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: b.companyId, agentId: b.agentId,
      invocationSource: "automation", status: "succeeded", finishedAt: new Date() }).returning();
    const [assignment] = await db.insert(museRunnerAssignments).values({ companyId: b.companyId,
      agentId: b.agentId, bindingId: b.id, bindingGeneration: b.generation, runId: run.id,
      normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1,
      catalogDigest: "test", status: "accepted", projection: {}, acceptBy: new Date(), expiresAt: new Date(Date.now() + 60_000) }).returning();
    await start();
    expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
    effects.reconcileTerminalAssignments.mockImplementationOnce(async () => {
      await db.update(museRunnerAssignments).set({ status: "settled", acceptedResultAt: new Date(), finalizedAt: run.finishedAt })
        .where(eq(museRunnerAssignments.id, assignment.id));
    });
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(coordinator.nextWakeAt()).toBeNull();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual(baseline);
  });
  it("honors a nearer qualification deadline while terminal settlement remains", async () => {
    const at = new Date(Date.now() + 1000);
    const expiring = await fixture(at);
    const b = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: b.companyId, agentId: b.agentId,
      invocationSource: "automation", status: "succeeded", finishedAt: new Date() }).returning();
    const [assignment] = await db.insert(museRunnerAssignments).values({ companyId: b.companyId,
      agentId: b.agentId, bindingId: b.id, bindingGeneration: b.generation, runId: run.id,
      normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1,
      catalogDigest: "test", status: "accepted", projection: {}, acceptBy: new Date(),
      expiresAt: new Date(Date.now() + 60_000) }).returning();
    await start();
    expect(coordinator.nextWakeAt()).toBe(at.getTime());
    expect(effects.endQualification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(Math.max(0, at.getTime() - Date.now())); await settle();
    expect(effects.endQualification).toHaveBeenCalledWith(expect.objectContaining({ bindingId: expiring.id }));
    expect((await db.select().from(museRunnerAssignments).where(eq(museRunnerAssignments.id, assignment.id)))[0].finalizedAt).toBeNull();
    expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
    effects.reconcileTerminalAssignments.mockImplementationOnce(async () => {
      await db.update(museRunnerAssignments).set({ status: "settled", acceptedResultAt: new Date(), finalizedAt: run.finishedAt })
        .where(eq(museRunnerAssignments.id, assignment.id));
    });
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(coordinator.nextWakeAt()).toBeNull();
    expect(errors).toEqual([]);
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual(baseline);
  });
  it("moves a scheduled deadline earlier on a committed change", async () => {
    const binding = await fixture(new Date(Date.now() + 600_000)); await start();
    const at = new Date(Date.now() + 60_000);
    await signalWrite(binding.id, at); await settle();
    expect(coordinator.nextWakeAt()).toBe(at.getTime());
  });
  it("recovers overdue qualifications at startup and retries failed reconciliation", async () => {
    await fixture(new Date(Date.now() - 1000));
    effects.endQualification.mockRejectedValueOnce(new Error("transient"));
    await start();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.endQualification).toHaveBeenCalledTimes(2);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("does no SQL in standby and recovers after claim", async () => {
    const binding = await fixture(new Date(Date.now() + 3_600_000));
    enabled = false; await start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toEqual([]);
    enabled = true;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledWith(binding.companyId, binding.agentId, binding.id, { limit: 100 });
    expect(calls.filter(c => c === "update")).toHaveLength(1);
  });
  it("pauses deadline maintenance during drain and catches up after release", async () => {
    await fixture(new Date(Date.now() + 1000)); await start();
    const baseline = [...calls]; draining = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual(baseline);
    draining = false;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.endQualification).toHaveBeenCalledTimes(1);
  });
  it("retains a first qualification committed during drain until dispatch resumes", async () => {
    const binding = await fixture(); await start();
    expect(coordinator.nextWakeAt()).toBeNull();
    draining = true;
    await signalWrite(binding.id, new Date(Date.now() + 1000)); await settle();
    expect(coordinator.nextWakeAt()).not.toBeNull();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual(baseline);
    expect(effects.endQualification).not.toHaveBeenCalled();
    draining = false;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.endQualification).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("retains startup recovery when the worker starts during drain", async () => {
    await fixture(new Date(Date.now() - 1000));
    draining = true; await start();
    expect(coordinator.nextWakeAt()).not.toBeNull();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual(baseline);
    draining = false;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.endQualification).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("preserves a failed sweep retry across drain", async () => {
    await fixture(); await start(true);
    expect(errors).toHaveLength(1);
    draining = true;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(coordinator.nextWakeAt()).not.toBeNull();
    const baseline = [...calls];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual(baseline);
    draining = false;
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
  it("retries startup evidence marking before reconciliation", async () => {
    await fixture(); await start(true);
    expect(effects.reconcileTerminalAssignments).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
    expect(calls.filter(c => c === "update")).toHaveLength(2);
  });
});
