import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, runtimeServiceAllocations, runtimeServiceCompanyPolicyEvents, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema, updateRuntimeServiceCompanyPolicySchema, updateRuntimeServicePolicySchema, type RuntimeServiceCompanyPolicyConfig } from "@paperclipai/shared";
import { createRuntimeServiceManager } from "./manager.js";
import type { RuntimeServiceProvider } from "./provider.js";

describe("company service limits with durable Postgres", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const actor = { type: "board" as const, id: "operator" };
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-company-services-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Policy", issuePrefix: `P${companyId.slice(0, 7)}` });
    let clock = new Date();
    const processes = new Set<string>();
    const provider: RuntimeServiceProvider = {
      key: "policy-fixture", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      start: vi.fn(async (ctx) => { processes.add(ctx.process.generation); return ctx.process; }),
      inspect: vi.fn(async (ctx) => ({ state: processes.has(ctx.process.generation) ? "running" as const : "missing" as const, endpoints: [] })),
      stop: vi.fn(async (ctx) => { processes.delete(ctx.process.generation); }), logs: vi.fn(async () => ""),
    };
    const make = () => createRuntimeServiceManager(db, { providers: [provider], clock: () => clock });
    const manager = make();
    const placement = { provider: provider.key, reuseKey: companyId, cwd: "/service-fixture" };
    async function create(extra = {}, reuseKey: string = placement.reuseKey) {
      return manager.create(companyId, actor, createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Service", command: "node server.js", purpose: "worker", ...extra }), { ...placement, reuseKey });
    }
    async function update(config: Partial<RuntimeServiceCompanyPolicyConfig>) {
      return manager.updateCompanyPolicy(companyId, actor, { requestId: randomUUID(), expectedRevision: (await manager.companyPolicy(companyId)).revision, config });
    }
    async function control(id: string, action: "start" | "stop" | "sleep" | "restart") {
      return manager.control(companyId, id, actor, { requestId: randomUUID(), expectedRevision: (await manager.get(companyId, id)).revision, action });
    }
    return { companyId, manager, make, create, update, control, provider, processes, placement, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
  }

  it("preserves omitted PATCH fields instead of injecting schema defaults", () => {
    const identity = { requestId: randomUUID(), expectedRevision: 0 };
    expect(updateRuntimeServiceCompanyPolicySchema.parse({ ...identity, config: { maxRunningServices: 2 } }).config).toEqual({ maxRunningServices: 2 });
    expect(updateRuntimeServiceCompanyPolicySchema.safeParse({ ...identity, config: {} }).success).toBe(false);
    expect(updateRuntimeServicePolicySchema.parse({ ...identity, policy: { idleSeconds: 60 } }).policy).toEqual({ idleSeconds: 60 });
    expect(updateRuntimeServicePolicySchema.safeParse({ ...identity, expectedPolicy: { idleSeconds: 60 }, policy: { idleSeconds: 90 } }).success).toBe(false);
    expect(updateRuntimeServicePolicySchema.parse({ ...identity, expectedPolicy: { idleSeconds: 60, maxRunningSeconds: null, keepRunningUntil: null, restartAttempts: 3, readinessTimeoutSeconds: 60 }, policy: { idleSeconds: 90 } }).expectedPolicy?.idleSeconds).toBe(60);
    expect(createRuntimeServiceSchema.parse({ requestId: identity.requestId, name: "Service", command: "node server.js", policy: { idleSeconds: 60 } }).policy).toEqual({ idleSeconds: 60 });
  });

  it("defaults old policies to permanent retention, bounds expiry and preserves it on unrelated patches", async () => {
    const f = await fixture();
    expect((await f.manager.companyPolicy(f.companyId)).config.retainedDataSeconds).toBeNull();
    const identity = { requestId: randomUUID(), expectedRevision: 0 };
    expect(updateRuntimeServiceCompanyPolicySchema.safeParse({ ...identity, config: { retainedDataSeconds: 86399 } }).success).toBe(false);
    expect(updateRuntimeServiceCompanyPolicySchema.safeParse({ ...identity, config: { retainedDataSeconds: 3651 * 86400 } }).success).toBe(false);
    expect(updateRuntimeServiceCompanyPolicySchema.safeParse({ ...identity, config: { retainedDataSeconds: 86400 } }).success).toBe(true);
    await f.update({ retainedDataSeconds: 86400 });
    expect((await f.update({ maxRunningServices: 2 })).config.retainedDataSeconds).toBe(86400);
    await f.update({ retainedDataSeconds: null });
    expect((await f.make().companyPolicy(f.companyId)).config.retainedDataSeconds).toBeNull();
  });

  it("copies company idle defaults only at creation and applies a live ceiling to saved per-service choices", async () => {
    const f = await fixture();
    const existing = await f.create({ purpose: "preview", start: false });
    expect(existing.policy.idleSeconds).toBe(3600);
    await f.update({ previewIdleSeconds: 120, workerIdleSeconds: 300, maxRunningSeconds: 600 });
    expect((await f.create({ purpose: "preview", start: false })).policy.idleSeconds).toBe(120);
    expect((await f.create({ start: false })).policy.idleSeconds).toBe(300);
    const explicit = await f.create({ start: false, policy: { idleSeconds: null, maxRunningSeconds: 1200 } });
    expect(explicit).toMatchObject({ policy: { idleSeconds: null, maxRunningSeconds: 1200 }, effectivePolicy: { maxRunningSeconds: 600 }, companyPolicyRevision: 1 });
    expect((await f.manager.get(f.companyId, existing.id)).policy.idleSeconds).toBe(3600);
    await f.update({ maxRunningSeconds: 900 });
    expect((await f.manager.companyPolicy(f.companyId)).config).toMatchObject({ previewIdleSeconds: 120, workerIdleSeconds: 300 });
    expect((await f.manager.get(f.companyId, explicit.id)).effectivePolicy?.maxRunningSeconds).toBe(900);
    await f.update({ maxRunningSeconds: null });
    expect((await f.manager.get(f.companyId, explicit.id)).effectivePolicy?.maxRunningSeconds).toBe(1200);
  });

  it("serializes competing creates across independent managers and counts shared allocations once", async () => {
    const f = await fixture(); await f.update({ maxRunningServices: 1, maxServiceAllocations: 1 });
    const inputs = [0, 1].map(() => createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Concurrent", command: "node server.js" }));
    const results = await Promise.allSettled(inputs.map((input) => f.make().create(f.companyId, actor, input, f.placement)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("running-service limit reached");
    const acceptedIndex = results.findIndex((result) => result.status === "fulfilled");
    const replay = await f.make().create(f.companyId, actor, inputs[acceptedIndex]!, f.placement);
    expect(replay.id).toBe((results[acceptedIndex] as PromiseFulfilledResult<typeof replay>).value.id);
    await f.create({ start: false });
    expect((await f.manager.companyPolicy(f.companyId)).usage).toEqual({ runningServices: 1, serviceAllocations: 1 });
    await expect(f.create({ start: false }, "another-workspace")).rejects.toThrow("retained-allocation limit reached");
    expect(f.provider.start).not.toHaveBeenCalled();
    expect(await db.select().from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.companyId, f.companyId))).toHaveLength(1);
  });

  it("reserves different workspace allocations atomically without applying one company's limit to another", async () => {
    const f = await fixture(); await f.update({ maxServiceAllocations: 1 });
    const results = await Promise.allSettled([f.create({ start: false }, "first-workspace"), f.create({ start: false }, "second-workspace")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
    const other = await fixture();
    await other.create({ start: false }, "first-workspace"); await other.create({ start: false }, "second-workspace");
    expect((await other.manager.companyPolicy(other.companyId)).usage.serviceAllocations).toBe(2);
    await other.update({ maxServiceAllocations: 1 });
    expect((await other.manager.companyPolicy(other.companyId)).usage.serviceAllocations).toBe(2);
    await other.create({ start: false }, "first-workspace");
    await expect(other.create({ start: false }, "third-workspace")).rejects.toThrow("retained-allocation limit reached");
  });

  it("serializes saved-service starts and preview wakes, keeping capacity until actual termination", async () => {
    const f = await fixture(); await f.update({ maxRunningServices: 1 });
    const first = await f.create({ start: false }); const second = await f.create({ start: false });
    const outcomes = await Promise.allSettled([f.control(first.id, "start"), f.control(second.id, "start")]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0]!.status === "fulfilled" ? first : second;
    const loser = winner.id === first.id ? second : first;
    await f.manager.reconcile(f.companyId, winner.id);
    expect(f.processes.size).toBe(1);
    await f.control(winner.id, "sleep");
    await expect(f.control(loser.id, "start")).rejects.toThrow("running-service limit reached");
    await f.manager.reconcile(f.companyId, winner.id);
    await f.control(loser.id, "start");
    await expect(f.make().wake(f.companyId, winner.id)).rejects.toThrow("running-service limit reached");
    expect((await f.manager.get(f.companyId, winner.id)).desiredState).toBe("sleeping");
    await f.control(loser.id, "stop"); await f.manager.reconcile(f.companyId, loser.id);
    await Promise.all([f.make().wake(f.companyId, winner.id), f.make().wake(f.companyId, winner.id)]);
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(1);
  });

  it("applies hard lifetime during visible use and keep-until, without allowing an automatic wake", async () => {
    const f = await fixture(); await f.update({ maxRunningSeconds: 10 });
    const service = await f.create({ policy: { keepRunningUntil: new Date(Date.now() + 3600_000).toISOString(), maxRunningSeconds: 3600 } });
    await f.manager.reconcile(f.companyId, service.id);
    f.advance(11_000); await f.manager.previewActivity(f.companyId, service.id, true);
    await f.manager.reconcile(f.companyId, service.id);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", desiredState: "stopped", stopReason: "company_maximum_lifetime" });
    expect(f.processes.size).toBe(0);
    await f.manager.wake(f.companyId, service.id);
    expect((await f.manager.get(f.companyId, service.id)).desiredState).toBe("stopped");
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(0);
  });

  it("keeps an unconfirmed stop in capacity and allows a retry without admitting another service", async () => {
    const f = await fixture(); await f.update({ maxRunningSeconds: 1, maxRunningServices: 1 });
    const service = await f.create(); await f.manager.reconcile(f.companyId, service.id);
    vi.mocked(f.provider.stop).mockRejectedValueOnce(new Error("private provider failure"));
    f.advance(2_000); await f.manager.reconcile(f.companyId, service.id);
    const failed = await f.manager.get(f.companyId, service.id);
    expect(failed).toMatchObject({ state: "failed", desiredState: "stopped" });
    expect(failed.error).toContain("Stop could not be confirmed; this service still reserves capacity");
    expect(failed.error).not.toContain("private provider failure");
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(1);
    await expect(f.create()).rejects.toThrow("running-service limit reached");
    await f.control(service.id, "stop"); await f.manager.reconcile(f.companyId, service.id);
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(0);
    expect(f.processes.size).toBe(0);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", error: null });
  });

  it("stops the newest excess reservations when a limit is lowered and preserves their allocation", async () => {
    const f = await fixture();
    const oldest = await f.create(); const newest = await f.create();
    await f.manager.reconcile(f.companyId, oldest.id); await f.manager.reconcile(f.companyId, newest.id);
    const policy = await f.update({ maxRunningServices: 1, maxServiceAllocations: 1 });
    expect(policy.usage.runningServices).toBe(2);
    expect(await f.manager.get(f.companyId, newest.id)).toMatchObject({ desiredState: "stopped", state: "stopping", stopReason: "company_running_limit" });
    expect((await f.manager.get(f.companyId, oldest.id)).desiredState).toBe("running");
    await f.update({ previewIdleSeconds: 300 });
    expect((await f.manager.get(f.companyId, oldest.id)).desiredState).toBe("running");
    // Starting the same stopping process still cannot undo a lowered cap.
    await expect(f.control(newest.id, "start")).rejects.toThrow("running-service limit reached");
    await f.manager.reconcile(f.companyId, newest.id);
    expect(f.processes.size).toBe(1);
    expect((await f.manager.companyPolicy(f.companyId)).usage).toEqual({ runningServices: 1, serviceAllocations: 1 });
    expect((await f.manager.list(f.companyId)).map((row) => row.id)).toEqual([oldest.id, newest.id]);
  });

  it("enforces a lowered deadline against the original start and frees failed reservations at their deadline", async () => {
    const f = await fixture(); const service = await f.create();
    await f.manager.reconcile(f.companyId, service.id); f.advance(20_000);
    await f.update({ maxRunningSeconds: 10 });
    expect((await f.manager.get(f.companyId, service.id)).stopReason).toBe("company_maximum_lifetime");
    await f.manager.reconcile(f.companyId, service.id);
    await f.control(service.id, "start"); await f.manager.reconcile(f.companyId, service.id);
    await db.update(runtimeServices).set({ state: "failed" }).where(eq(runtimeServices.id, service.id));
    expect(await f.manager.reconciliationCandidates("observe", 100)).not.toContainEqual({ id: service.id, companyId: f.companyId });
    f.advance(11_000);
    expect(await f.manager.reconciliationCandidates("observe", 100)).toContainEqual({ id: service.id, companyId: f.companyId });
    await f.manager.reconcile(f.companyId, service.id);
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(0);
  });

  it("fences a provider start already in flight when a company cap is lowered", async () => {
    const f = await fixture();
    const oldest = await f.create(); await f.manager.reconcile(f.companyId, oldest.id);
    const newest = await f.create();
    let began!: () => void; const entered = new Promise<void>((resolve) => { began = resolve; });
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(f.provider.start).mockImplementationOnce(async (ctx) => { began(); await wait; f.processes.add(ctx.process.generation); return ctx.process; });
    const starting = f.manager.reconcile(f.companyId, newest.id);
    try {
      await entered;
      await f.update({ maxRunningServices: 1 });
      expect((await f.manager.get(f.companyId, newest.id)).state).toBe("stopping");
      await expect(f.control(newest.id, "restart")).rejects.toThrow("running-service limit reached");
    } finally { release(); await starting; }
    expect(await f.manager.get(f.companyId, newest.id)).toMatchObject({ state: "stopping", desiredState: "stopped" });
    await f.manager.reconcile(f.companyId, newest.id);
    expect(f.processes.size).toBe(1);
    expect((await f.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(1);
  });

  it("recovers an old company-policy retry without resetting later changes or duplicating the audit", async () => {
    const f = await fixture();
    const input = { requestId: randomUUID(), expectedRevision: 0, config: { maxRunningServices: 3 } };
    await f.manager.updateCompanyPolicy(f.companyId, actor, input);
    await f.update({ maxRunningSeconds: 60 });
    const replay = await f.make().updateCompanyPolicy(f.companyId, actor, input);
    expect(replay).toMatchObject({ revision: 2, config: { maxRunningServices: 3, maxRunningSeconds: 60 } });
    await expect(f.manager.updateCompanyPolicy(f.companyId, actor, { ...input, config: { maxRunningServices: 4 } })).rejects.toThrow("already used");
    await expect(f.manager.updateCompanyPolicy(f.companyId, actor, { ...input, requestId: randomUUID() })).rejects.toThrow("Company policy changed");
    expect(await db.select().from(runtimeServiceCompanyPolicyEvents).where(eq(runtimeServiceCompanyPolicyEvents.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "runtime_service.company_policy_changed")))).toHaveLength(2);
    await expect(f.manager.updateCompanyPolicy(f.companyId, { type: "agent", id: randomUUID() }, input)).rejects.toThrow("Only an operator");
    const other = await fixture();
    expect((await other.manager.companyPolicy(other.companyId)).config.maxRunningServices).toBeNull();
  });
});
