import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, applyPendingMigrations, heartbeatRuns, museRunnerAssignments, museAgentBindings, museCredentials, subscribeDatabaseWork } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { notifyMuseContactVerification, parseMuseVerificationHint } from "../modules/external-agents/index.js";
import * as externalAgents from "../modules/external-agents/index.js";
import { museCredentialHash } from "./muse-identity.js";
import { instanceSettingsService } from "./instance-settings.js";
import { startMuseMaintenance } from "./muse-maintenance.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { idleWorkSnapshot } from "./task-admission.js";

const effects = vi.hoisted(() => ({
  verify: vi.fn(), endQualification: vi.fn(), revokeOAuthGrant: vi.fn(), reconcileTerminalAssignments: vi.fn(),
  start: vi.fn(), stop: vi.fn(), flush: vi.fn(),
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
    effects.flush.mockResolvedValue(undefined);
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
  async function start(failFirstUpdate = false, waitForAllOwners = true) {
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
    if (waitForAllOwners) await settle();
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

  it("registers first-contact intent before its write, including a currently paused identity", async () => {
    const binding = await fixture();
    await db.update(agents).set({ status: "paused", lifecycleState: "paused" }).where(eq(agents.id, binding.agentId));
    await db.update(museAgentBindings).set({ pairedAt: new Date() }).where(eq(museAgentBindings.id, binding.id));
    const hints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.museMaintenance, (event, values) => {
      if (event === "intent") hints.push(...values ?? []);
    });
    try {
      await expect(db.transaction(async tx => {
        expect(await notifyMuseContactVerification(tx, {
          companyId: binding.companyId, bindingId: binding.id, generation: binding.generation,
        }, "contact-persist")).toBe(1);
        expect(hints.map(parseMuseVerificationHint)).toEqual([{
          kind: "muse-contact-verification", companyId: binding.companyId,
          bindingId: binding.id, generation: binding.generation,
        }]);
        const [before] = await tx.select().from(museAgentBindings).where(eq(museAgentBindings.id, binding.id));
        expect(before.receiverContactAt).toBeNull();
        await tx.update(museAgentBindings).set({ receiverContactAt: new Date() }).where(eq(museAgentBindings.id, binding.id));
        throw new Error("first contact rollback");
      })).rejects.toThrow("first contact rollback");
      const [after] = await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, binding.id));
      expect(after.receiverContactAt).toBeNull();
      expect(after.challengeHash).toBeNull();
    } finally { unsubscribe(); }
  });

  it("targets only pending contact bindings for the affected company and operator", async () => {
    const binding = await fixture();
    const foreign = await fixture();
    const otherOperator = await fixture();
    for (const pending of [binding, foreign, otherOperator]) {
      await db.update(museAgentBindings).set({ pairedAt: new Date(), receiverContactAt: new Date() })
        .where(eq(museAgentBindings.id, pending.id));
    }
    const [otherAgent] = await db.insert(agents).values({ companyId: binding.companyId, name: "Other Muse agent" }).returning();
    await db.update(museAgentBindings).set({ companyId: binding.companyId, agentId: otherAgent.id,
      operatorId: "another-operator" }).where(eq(museAgentBindings.id, otherOperator.id));
    const hints: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.museMaintenance, (event, values) => {
      if (event === "intent") hints.push(...values ?? []);
    });
    try {
      await db.transaction(async tx => {
        expect(await notifyMuseContactVerification(tx, {
          companyId: binding.companyId, operatorId: binding.operatorId,
        })).toBe(1);
      });
      expect(hints.map(parseMuseVerificationHint)).toEqual([{
        kind: "muse-contact-verification", companyId: binding.companyId,
        bindingId: binding.id, generation: binding.generation,
      }]);
      expect(hints.some(hint => hint.includes(foreign.id) || hint.includes(otherOperator.id))).toBe(false);
      await db.transaction(async tx => {
        expect(await notifyMuseContactVerification(tx, { companyId: binding.companyId,
          bindingId: binding.id, generation: binding.generation + 1 })).toBe(0);
      });
      expect(hints).toHaveLength(1);
      await db.update(museAgentBindings).set({ verifiedReplyAt: new Date() }).where(eq(museAgentBindings.id, binding.id));
      await db.transaction(async tx => {
        expect(await notifyMuseContactVerification(tx, { companyId: binding.companyId,
          operatorId: binding.operatorId })).toBe(0);
      });
      expect(hints).toHaveLength(1);
    } finally { unsubscribe(); }
  });

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
  it("keeps local qualification work responsive while startup Cloud continuity is pending and retries only its debt", async () => {
    const flags = await instanceSettingsService(db).getExperimentalReadOnly();
    await instanceSettingsService(db).updateExperimental({ enableMuse: true, enableNativeRunner: true });
    const stable = await fixture(new Date(Date.now() + 3_600_000));
    const changed = await fixture(new Date(Date.now() + 3_600_000));
    const uncovered = await fixture(new Date(Date.now() + 3_600_000));
    const expired = await fixture(new Date(Date.now() - 1000));
    const at = new Date(Date.now() + 1000), near = await fixture(at);
    await db.update(museAgentBindings).set({ pairedAt: new Date(), receiverContactAt: new Date(), workerActivityAt: new Date() })
      .where(eq(museAgentBindings.id, changed.id));
    await db.insert(museCredentials).values({ companyId: changed.companyId, bindingId: changed.id,
      bindingGeneration: changed.generation, kind: "refresh", familyId: randomUUID(),
      tokenHash: museCredentialHash(randomUUID()), expiresAt: new Date(Date.now() + 4 * 3_600_000) });
    const credentialBefore = await db.select().from(museCredentials).where(eq(museCredentials.bindingId, changed.id));
    // Existing broker port: record the ordinary challenge request's revision
    // commit, never seed an authenticated reply or a successful qualification.
    effects.verify.mockImplementation(async (_companyId: string, _agentId: string,
      input: { bindingId: string; generation: number; expectedRevision: number }) => {
      expect(input.bindingId).toBe(changed.id);
      const rows = await db.update(museAgentBindings).set({ challengeHash: museCredentialHash(randomUUID()),
        challengeExpiresAt: new Date(Date.now() + 600_000), revision: input.expectedRevision + 1 })
        .where(and(eq(museAgentBindings.id, input.bindingId), eq(museAgentBindings.companyId, _companyId),
          eq(museAgentBindings.generation, input.generation), eq(museAgentBindings.revision, input.expectedRevision))).returning();
      expect(rows).toHaveLength(1);
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let mode: "pending" | "outage" | "owned" = "pending";
    // Controlled scheduling boundary only. recoverMuseReceiverContinuity's
    // authenticated Cloud transport/projection implementation is unchanged.
    const recover = vi.spyOn(externalAgents, "recoverMuseReceiverContinuity").mockImplementation(async (_owner, signal) => {
      if (mode === "pending") await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        gate.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      signal.throwIfAborted();
      if (mode !== "owned") throw new Error("Controlled Cloud continuity unavailable");
      return new Map([[stable.id, stable.generation]]);
    });
    const starting = start(false, false);
    void starting.catch(() => {});
    let primaryFailed = false;
    let primaryFailure: unknown;
    try {
      await vi.waitFor(() => {
        expect(recover).toHaveBeenCalledTimes(1);
        expect(effects.endQualification).toHaveBeenCalledWith(expect.objectContaining({ bindingId: expired.id }));
        expect(effects.verify).toHaveBeenCalledWith(changed.companyId, changed.agentId,
          { bindingId: changed.id, generation: changed.generation, expectedRevision: changed.revision });
      });
      expect(idleWorkSnapshot().active).toBeGreaterThan(0); // Real unresolved startup owner remains held.
      expect(coordinator.nextWakeAt()).toBe(at.getTime());
      await vi.advanceTimersByTimeAsync(Math.max(0, at.getTime() - Date.now()));
      await vi.waitFor(() => expect(effects.endQualification).toHaveBeenCalledWith(expect.objectContaining({ bindingId: near.id })));
      expect(errors).toEqual([]);
      mode = "outage"; release(); await starting; await settle();
      expect(errors).toHaveLength(1);
      expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
      await vi.advanceTimersByTimeAsync(5000); await settle();
      expect(recover).toHaveBeenCalledTimes(2); expect(errors).toHaveLength(2);
      mode = "owned";
      await vi.advanceTimersByTimeAsync(5000); await settle();
      expect(recover).toHaveBeenCalledTimes(3);
      const rows = await db.select().from(museAgentBindings);
      expect(rows.find(row => row.id === stable.id)?.cadenceEvidenceIncompleteAt).toBeNull();
      expect(rows.find(row => row.id === changed.id)).toMatchObject({ revision: changed.revision + 1,
        verifiedReplyAt: null });
      expect(rows.find(row => row.id === changed.id)?.cadenceEvidenceIncompleteAt).toBeInstanceOf(Date);
      expect(rows.find(row => row.id === uncovered.id)?.cadenceEvidenceIncompleteAt).toBeInstanceOf(Date);
      expect(await db.select().from(museCredentials).where(eq(museCredentials.bindingId, changed.id))).toEqual(credentialBefore);
      // Let the original remaining qualification deadlines expire normally;
      // then startup recovery is complete and no empty five-second duty remains.
      await vi.advanceTimersByTimeAsync(3_600_000); await settle();
      expect(coordinator.nextWakeAt()).toBeNull();
      const baseline = [...calls];
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls).toEqual(baseline); expect(recover).toHaveBeenCalledTimes(3);
    } catch (error) {
      primaryFailed = true; primaryFailure = error;
    } finally {
      mode = "owned"; release();
      const cleanupFailures: unknown[] = [];
      const attempt = async (cleanup: () => unknown) => {
        try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
      };
      await attempt(() => starting);
      await attempt(() => coordinator?.stop());
      await attempt(() => stop?.());
      await attempt(() => recover.mockRestore());
      await attempt(() => instanceSettingsService(db).updateExperimental({
        enableMuse: flags.enableMuse, enableNativeRunner: flags.enableNativeRunner }));
      if (primaryFailed && cleanupFailures.length) throw new AggregateError(
        [primaryFailure, ...cleanupFailures], "Muse continuity assertion and cleanup failed", { cause: primaryFailure });
      if (primaryFailed) throw primaryFailure;
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Muse continuity cleanup failed");
    }
  });

  it("honors a nearer future qualification while overdue local recovery and Cloud continuity both fail", async () => {
    const expired = await fixture(new Date(Date.now() - 1000));
    const at = new Date(Date.now() + 1000), near = await fixture(at);
    let unavailable = true;
    const endQualification = effects.endQualification.getMockImplementation()!;
    effects.endQualification.mockImplementation(async (input) => {
      if (unavailable && input.bindingId === expired.id) throw new Error("Controlled overdue qualification unavailable");
      return endQualification(input);
    });
    const recover = vi.spyOn(externalAgents, "recoverMuseReceiverContinuity").mockImplementation(async () => {
      if (unavailable) throw new Error("Controlled Cloud continuity unavailable");
      return new Map();
    });
    let primaryFailed = false;
    let primaryFailure: unknown;
    try {
      await start();
      expect(recover).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(2); // Both concrete duties remain unresolved.
      expect((await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, expired.id)))[0].revokedAt).toBeNull();
      expect(coordinator.nextWakeAt()).toBe(at.getTime());
      await vi.advanceTimersByTimeAsync(Math.max(0, at.getTime() - Date.now())); await settle();
      expect(effects.endQualification).toHaveBeenCalledWith(expect.objectContaining({ bindingId: near.id }));
      expect((await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, near.id)))[0].revokedAt).toBeInstanceOf(Date);
      expect(recover).toHaveBeenCalledTimes(1); // No early Cloud retry for a local deadline.
      expect(errors).toHaveLength(3);
      expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
      unavailable = false;
      await vi.advanceTimersByTimeAsync(5000); await settle();
      expect(recover).toHaveBeenCalledTimes(2);
      expect((await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, expired.id)))[0].revokedAt).toBeInstanceOf(Date);
      expect(coordinator.nextWakeAt()).toBeNull();
      const baseline = [...calls];
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls).toEqual(baseline); expect(recover).toHaveBeenCalledTimes(2);
    } catch (error) {
      primaryFailed = true; primaryFailure = error;
    } finally {
      unavailable = false;
      const cleanupFailures: unknown[] = [];
      const attempt = async (cleanup: () => unknown) => {
        try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
      };
      await attempt(() => coordinator?.stop());
      await attempt(() => stop?.());
      await attempt(() => recover.mockRestore());
      if (primaryFailed && cleanupFailures.length) throw new AggregateError(
        [primaryFailure, ...cleanupFailures], "Muse nearer-deadline assertion and cleanup failed", { cause: primaryFailure });
      if (primaryFailed) throw primaryFailure;
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Muse nearer-deadline cleanup failed");
    }
  });

  it("keeps original qualification history incomplete after expiry and revocation during startup Cloud recovery", async () => {
    const at = new Date(Date.now() + 1000), original = await fixture(at);
    const broker = externalAgents.museExternalAgents(db);
    // Use the actual broker's deadline/revoke path: it retains qualificationId,
    // increments revision and records deadlineEnforcedAt. Only receiver flush
    // remains the existing controlled port; no provider/auth proof is claimed.
    effects.endQualification.mockImplementation(input => broker.endQualification(input));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const recover = vi.spyOn(externalAgents, "recoverMuseReceiverContinuity").mockImplementation(async (_owner, signal) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        gate.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      signal.throwIfAborted();
      return new Map();
    });
    const starting = start(false, false);
    void starting.catch(() => {});
    let primaryFailed = false;
    let primaryFailure: unknown;
    try {
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
      await starting;
      expect(coordinator.nextWakeAt()).toBe(at.getTime());
      await vi.advanceTimersByTimeAsync(Math.max(0, at.getTime() - Date.now()));
      await vi.waitFor(async () => {
        const [row] = await db.select().from(museAgentBindings).where(eq(museAgentBindings.id, original.id));
        expect(row).toMatchObject({ qualificationId: original.qualificationId, generation: original.generation,
          revision: original.revision + 1 });
        expect(row.revokedAt).toBeInstanceOf(Date);
        expect(row.deadlineEnforcedAt).toBeInstanceOf(Date);
      });
      // A qualification first created after the finite startup snapshot must
      // not inherit the original qualification's missing-history mark.
      const later = await fixture(new Date(Date.now() + 3_600_000));
      release(); await settle();
      const evidence = await broker.readQualificationEvidence(original.companyId, original.agentId,
        original.id, original.qualificationId!);
      expect(evidence).toMatchObject({ qualificationId: original.qualificationId,
        authorityRevoked: true, cadenceEvidenceComplete: false, idleWindows: [] });
      expect(evidence.stoppedAt).not.toBeNull();
      expect(evidence.deadlineEnforcedAt).not.toBeNull();
      const rows = await db.select().from(museAgentBindings);
      expect(rows.find(row => row.id === original.id)?.cadenceEvidenceIncompleteAt).toBeInstanceOf(Date);
      expect(rows.find(row => row.id === later.id)?.cadenceEvidenceIncompleteAt).toBeNull();
      expect(errors).toEqual([]);
    } catch (error) {
      primaryFailed = true; primaryFailure = error;
    } finally {
      release();
      const cleanupFailures: unknown[] = [];
      const attempt = async (cleanup: () => unknown) => {
        try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
      };
      await attempt(() => starting);
      await attempt(() => coordinator?.stop());
      await attempt(() => stop?.());
      await attempt(() => recover.mockRestore());
      if (primaryFailed && cleanupFailures.length) throw new AggregateError(
        [primaryFailure, ...cleanupFailures], "Muse qualification-history assertion and cleanup failed", { cause: primaryFailure });
      if (primaryFailed) throw primaryFailure;
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Muse qualification-history cleanup failed");
    }
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
  it("retries startup evidence marking without blocking independent reconciliation", async () => {
    await fixture(); await start(true);
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(effects.reconcileTerminalAssignments).toHaveBeenCalledTimes(1);
    expect(calls.filter(c => c === "update")).toHaveLength(2);
  });
});
