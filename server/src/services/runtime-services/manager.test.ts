import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema, type RuntimeServiceAction } from "@paperclipai/shared";
import { createRuntimeServiceManager, type RuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import type { RuntimeServiceProvider } from "./provider.js";
import { createRuntimeServiceControllerOwnership } from "./controller-ownership.js";

describe("runtime service lifecycle with durable Postgres and real subprocesses", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let clock = new Date();
  const actor = { type: "board" as const, id: "test-operator" };
  const tracked: Array<{ manager: RuntimeServiceManager; companyId: string; id: string }> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-services-v2-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-services-v2-"));
  }, 30_000);
  afterEach(async () => {
    for (const item of tracked.splice(0)) {
      const current = await item.manager.get(item.companyId, item.id);
      if (current.state === "deleted") continue;
      await item.manager.control(item.companyId, item.id, actor, { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" });
      await item.manager.reconcile(item.companyId, item.id);
    }
  });
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

  async function fixture(provider?: RuntimeServiceProvider, options: Partial<Parameters<typeof createRuntimeServiceManager>[1]> = {}) {
    clock = new Date();
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Services acceptance", issuePrefix: `S${companyId.slice(0, 6)}` });
    const cwd = path.join(root, companyId);
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "content.txt"), "first uncommitted edit");
    await fs.writeFile(path.join(cwd, "server.cjs"), `const fs = require('node:fs'); console.log('Service booted'); require('node:http').createServer((q,s) => s.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT), '127.0.0.1');`);
    const make = () => createRuntimeServiceManager(db, {
      providers: [provider ?? createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors") })],
      clock: () => clock,
      ...options,
    });
    const manager = make();
    const placement = { provider: provider?.key ?? "local", cwd, reuseKey: cwd };
    async function create(extra = {}) {
      const input = createRuntimeServiceSchema.parse({ name: "Web", command: "node server.cjs", endpoints: [{ name: "web" }], requestId: randomUUID(), ...extra });
      const service = await manager.create(companyId, actor, input, placement);
      tracked.push({ manager, companyId, id: service.id });
      return service;
    }
    return { companyId, cwd, manager, make, placement, create };
  }
  async function ready(manager: RuntimeServiceManager, companyId: string, id: string) {
    for (let index = 0; index < 50; index++) {
      await manager.reconcile(companyId, id);
      const service = await manager.get(companyId, id);
      if (service.state === "ready") return service;
      if (service.state === "failed") throw new Error(service.error ?? "Service failed");
      await delay(40);
    }
    throw new Error("Service did not become ready");
  }
  async function control(manager: RuntimeServiceManager, companyId: string, id: string, action: RuntimeServiceAction) {
    const service = await manager.get(companyId, id);
    await manager.control(companyId, id, actor, { action, expectedRevision: service.revision, requestId: randomUUID() });
    await manager.reconcile(companyId, id);
    return manager.get(companyId, id);
  }

  it("recovers a dead local controller before lease expiry and preserves a live successor claim", async () => {
    const host = "a".repeat(64);
    let absent = false;
    const ownership = createRuntimeServiceControllerOwnership({ hostIdentity: async () => host, processAbsent: () => absent });
    const f = await fixture(undefined, { controllerOwnership: ownership });
    const service = await f.create();
    await ready(f.manager, f.companyId, service.id);
    const claimId = await ownership.claimId();
    await db.update(runtimeServices).set({ controllerId: claimId, controllerExpiresAt: new Date(clock.getTime() + 60_000) }).where(eq(runtimeServices.id, service.id));
    await control(f.manager, f.companyId, service.id, "stop");
    expect((await f.manager.get(f.companyId, service.id)).state).toBe("stopping");
    expect(await f.manager.reconciliationCandidates("stop", 4)).toEqual([]);
    absent = true;
    const successor = f.make();
    expect(await successor.reconciliationCandidates("stop", 4)).toContainEqual({ id: service.id, companyId: f.companyId });
    await successor.reconcile(f.companyId, service.id);
    expect((await successor.get(f.companyId, service.id)).state).toBe("stopped");

    // An ownership probe racing a replacement may not erase the replacement.
    await db.update(runtimeServices).set({ controllerId: claimId, controllerExpiresAt: new Date(clock.getTime() + 60_000) }).where(eq(runtimeServices.id, service.id));
    const replacementId = await ownership.claimId();
    const manager = createRuntimeServiceManager(db, { providers: [], clock: () => clock, controllerOwnership: {
      ...ownership, async isDead() {
        await db.update(runtimeServices).set({ controllerId: replacementId }).where(eq(runtimeServices.id, service.id));
        return true;
      },
    } });
    await manager.reconciliationCandidates("stop", 4);
    expect((await f.manager.getRecord(f.companyId, service.id)).service.controllerId).toBe(replacementId);
    await db.update(runtimeServices).set({ controllerId: null, controllerExpiresAt: null }).where(eq(runtimeServices.id, service.id));
  });

  it("keeps a remote service lease even when its local controller is confirmed dead", async () => {
    const ownership = createRuntimeServiceControllerOwnership({ hostIdentity: async () => "c".repeat(64), processAbsent: () => true });
    const provider: RuntimeServiceProvider = {
      key: "remote-test", capabilities: { dynamicPorts: true, logs: true, preview: true, preservesDataOnStop: true },
      async inspect() { return { state: "missing", endpoints: [] }; }, async start(ctx) { return ctx.process; },
      async stop() {}, async logs() { return ""; },
    };
    const f = await fixture(provider, { controllerOwnership: ownership });
    const service = await f.create({ endpoints: [] });
    const claimId = await ownership.claimId();
    await db.update(runtimeServices).set({ controllerId: claimId, controllerExpiresAt: new Date(clock.getTime() + 60_000) }).where(eq(runtimeServices.id, service.id));
    expect(await f.manager.reconciliationCandidates("start", 4)).toEqual([]);
    expect((await f.manager.getRecord(f.companyId, service.id)).service.controllerId).toBe(claimId);
    await db.update(runtimeServices).set({ controllerId: null, controllerExpiresAt: null }).where(eq(runtimeServices.id, service.id));
  });

  it("saves a policy across lifecycle changes without restarting the process or replaying an old edit", async () => {
    const f = await fixture(), created = await f.create();
    const running = await ready(f.manager, f.companyId, created.id);
    expect(running.revision).toBeGreaterThan(created.revision);
    const before = (await f.manager.getRecord(f.companyId, created.id)).service.processRef;
    const input = { requestId: randomUUID(), expectedRevision: created.revision, expectedPolicy: created.policy, policy: { idleSeconds: 7200 } };
    const saved = await f.manager.updatePolicy(f.companyId, created.id, actor, input);
    expect(saved).toMatchObject({ state: "ready", desiredState: "running", policy: { idleSeconds: 7200 } });
    expect((await f.manager.getRecord(f.companyId, created.id)).service.processRef).toEqual(before);
    const newer = await f.manager.updatePolicy(f.companyId, created.id, actor, { requestId: randomUUID(), expectedRevision: saved.revision, expectedPolicy: saved.policy, policy: { idleSeconds: 9000 } });
    expect((await f.manager.updatePolicy(f.companyId, created.id, actor, input)).policy).toEqual(newer.policy);
    await expect(f.manager.updatePolicy(f.companyId, created.id, actor, { ...input, expectedPolicy: newer.policy })).rejects.toThrow("different action");
  });

  it("rejects competing policy edits atomically even when both use the same baseline", async () => {
    const f = await fixture(), service = await f.create();
    const results = await Promise.allSettled([7200, 9000].map(idleSeconds => f.manager.updatePolicy(f.companyId, service.id, actor, {
      requestId: randomUUID(), expectedRevision: service.revision, expectedPolicy: service.policy, policy: { idleSeconds },
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toContain("Service lifetime changed");
    const fulfilled = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<RuntimeServiceManager["get"]>>>;
    expect((await f.manager.get(f.companyId, service.id)).policy).toEqual(fulfilled.value.policy);
  });

  it("keeps strict revision checks for older policy clients and rejects future revisions", async () => {
    const f = await fixture(), service = await f.create();
    const running = await ready(f.manager, f.companyId, service.id);
    await expect(f.manager.updatePolicy(f.companyId, service.id, actor, { requestId: randomUUID(), expectedRevision: service.revision, policy: { idleSeconds: 7200 } })).rejects.toThrow("Service changed");
    await expect(f.manager.updatePolicy(f.companyId, service.id, actor, { requestId: randomUUID(), expectedRevision: running.revision + 1, expectedPolicy: running.policy, policy: { idleSeconds: 7200 } })).rejects.toThrow("Service lifetime changed");
    await expect(f.manager.updatePolicy(f.companyId, service.id, actor, { requestId: randomUUID(), expectedRevision: running.revision, expectedPolicy: { ...running.policy, idleSeconds: 99 }, policy: { idleSeconds: 7200 } })).rejects.toThrow("Service lifetime changed");
    expect((await f.manager.get(f.companyId, service.id)).policy).toEqual(running.policy);
  });

  it("serves dirty files, recovers its existing process after controller replacement, and retains logs after stop", async () => {
    const f = await fixture();
    const created = await f.create();
    const running = await ready(f.manager, f.companyId, created.id);
    const before = (await f.manager.getRecord(f.companyId, created.id)).service.processRef;
    const url = `http://127.0.0.1:${running.endpoints[0]!.port}`;
    expect(await (await fetch(url)).text()).toBe("first uncommitted edit");
    await fs.writeFile(path.join(f.cwd, "content.txt"), "continued from next run");
    // Simulate a crash after launch committed to the supervisor but before the
    // controller saved the receipt. The replacement must recover, not launch.
    await db.update(runtimeServices).set({ state: "starting", processRef: { generation: before!.generation, launchedAt: before!.launchedAt } }).where(eq(runtimeServices.id, created.id));
    const replacement = f.make();
    await ready(replacement, f.companyId, created.id);
    expect((await replacement.getRecord(f.companyId, created.id)).service.processRef).toEqual(before);
    expect(await (await fetch(url)).text()).toBe("continued from next run");
    const stopped = await control(replacement, f.companyId, created.id, "stop");
    expect(stopped.state).toBe("stopped");
    await expect(fetch(url)).rejects.toThrow();
    expect(await replacement.logs(f.companyId, created.id)).toContain("Service booted");
    expect(await fs.readFile(path.join(f.cwd, "content.txt"), "utf8")).toBe("continued from next run");
    expect(await replacement.wake(f.companyId, created.id)).toMatchObject({ desiredState: "stopped" });
    await control(replacement, f.companyId, created.id, "start");
    await ready(replacement, f.companyId, created.id);
  });

  it("sleeps only the idle preview, keeps a worker alive, and wakes with retained files", async () => {
    const f = await fixture();
    const web = await f.create({ policy: { idleSeconds: 60 } });
    const worker = await f.create({ name: "Worker", purpose: "worker", endpoints: [], command: "node -e 'setInterval(() => {}, 1000)'" });
    await ready(f.manager, f.companyId, web.id);
    await ready(f.manager, f.companyId, worker.id);
    expect(worker.allocationId).toBe(web.allocationId);
    clock = new Date(clock.getTime() + 59_000);
    await f.manager.activity(f.companyId, web.id, true);
    clock = new Date(clock.getTime() + 59_000);
    await f.manager.reconcile(f.companyId, web.id);
    expect((await f.manager.get(f.companyId, web.id)).state).toBe("ready");
    await f.manager.activity(f.companyId, web.id, false);
    clock = new Date(clock.getTime() + 2_000);
    await f.manager.reconcile(f.companyId, web.id);
    await f.manager.reconcile(f.companyId, worker.id);
    expect((await f.manager.get(f.companyId, web.id)).state).toBe("sleeping");
    expect((await f.manager.get(f.companyId, worker.id)).state).toBe("ready");
    await f.manager.wake(f.companyId, web.id);
    const resumed = await ready(f.manager, f.companyId, web.id);
    expect(await (await fetch(`http://127.0.0.1:${resumed.endpoints[0]!.port}`)).text()).toBe("first uncommitted edit");
  });

  it("selects independent work queues and excludes claimed or already dispatched services", async () => {
    const f = await fixture();
    const start = await f.create({ name: "Pending" });
    const observe = await f.create({ name: "Running" });
    const stop = await f.create({ name: "Stopping" });
    const claimed = await f.create({ name: "Claimed" });
    const other = await fixture();
    const otherStart = await other.create({ name: "Other company" });
    await db.update(runtimeServices).set({ state: "ready" }).where(eq(runtimeServices.id, observe.id));
    await db.update(runtimeServices).set({ state: "stopping", desiredState: "stopped" }).where(eq(runtimeServices.id, stop.id));
    await db.update(runtimeServices).set({ controllerId: randomUUID(), controllerExpiresAt: new Date(clock.getTime() + 60_000) }).where(eq(runtimeServices.id, claimed.id));
    expect(await f.manager.reconciliationCandidates("start", 20)).toEqual(expect.arrayContaining([
      { id: start.id, companyId: f.companyId }, { id: otherStart.id, companyId: other.companyId },
    ]));
    expect(await f.manager.reconciliationCandidates("start", 20, [start.id, otherStart.id])).toEqual([]);
    expect(await f.manager.reconciliationCandidates("start", 1)).toHaveLength(1);
    expect(await f.manager.reconciliationCandidates("observe", 20)).toEqual([{ id: observe.id, companyId: f.companyId }]);
    expect(await f.manager.reconciliationCandidates("stop", 20)).toEqual([{ id: stop.id, companyId: f.companyId }]);
    await db.update(runtimeServices).set({ controllerExpiresAt: new Date(clock.getTime() - 1) }).where(eq(runtimeServices.id, claimed.id));
    expect(await f.manager.reconciliationCandidates("start", 20, [start.id, otherStart.id])).toEqual([{ id: claimed.id, companyId: f.companyId }]);
  });

  it("enforces hard lifetime even while visible and held open", async () => {
    const f = await fixture();
    const service = await f.create({ policy: { maxRunningSeconds: 10, keepRunningUntil: new Date(clock.getTime() + 3600_000).toISOString() } });
    await ready(f.manager, f.companyId, service.id);
    clock = new Date(clock.getTime() + 11_000);
    await f.manager.activity(f.companyId, service.id, true);
    await f.manager.reconcile(f.companyId, service.id);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", stopReason: "maximum_lifetime" });
  });

  it("releases stopped allocation compute after the last agent ends while retaining its data", async () => {
    let activeRun = true;
    let releases = 0;
    const provider: RuntimeServiceProvider = {
      key: "retained", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { return ctx.process; }, async inspect() { return { state: "running", endpoints: [] }; },
      async stop() {}, async logs() { return ""; }, async retainAllocation() {},
      async releaseCompute() { releases++; return activeRun ? "retained" : "stopped"; },
    };
    const f = await fixture(provider);
    const web = await f.create({ endpoints: [] });
    const api = await f.create({ endpoints: [] });
    await ready(f.manager, f.companyId, web.id);
    await ready(f.manager, f.companyId, api.id);
    await control(f.manager, f.companyId, web.id, "stop");
    expect(releases).toBe(0);
    await control(f.manager, f.companyId, api.id, "stop");
    expect(await f.manager.get(f.companyId, web.id)).toMatchObject({ retention: { state: "retained", compute: "retained" } });
    activeRun = false;
    clock = new Date(clock.getTime() + 61_000);
    await f.make().tick();
    expect(await f.manager.get(f.companyId, web.id)).toMatchObject({ retention: { state: "retained", compute: "stopped" } });
    expect(await fs.readFile(path.join(f.cwd, "content.txt"), "utf8")).toBe("first uncommitted edit");
  });

  it("does not launch when the provider cannot guarantee retained data", async () => {
    let launches = 0;
    const provider: RuntimeServiceProvider = {
      key: "unretained", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { launches++; return ctx.process; }, async inspect() { return { state: "missing", endpoints: [] }; },
      async stop() {}, async logs() { return ""; }, async retainAllocation() { throw new Error("provider private token"); },
    };
    const f = await fixture(provider);
    const service = await f.create({ endpoints: [] });
    await f.manager.reconcile(f.companyId, service.id);
    expect(launches).toBe(0);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "failed", retention: { state: "failed" }, error: expect.stringContaining("retention could not be verified") });
    expect(JSON.stringify(await f.manager.get(f.companyId, service.id))).not.toContain("private token");
  });

  it("deduplicates concurrent creation and rejects conflicting replay and stale controls", async () => {
    const f = await fixture();
    const input = createRuntimeServiceSchema.parse({ name: "Once", command: "node server.cjs", requestId: randomUUID(), start: false });
    const [one, two] = await Promise.all([f.manager.create(f.companyId, actor, input, f.placement), f.manager.create(f.companyId, actor, input, f.placement)]);
    expect(one.id).toBe(two.id);
    tracked.push({ manager: f.manager, companyId: f.companyId, id: one.id });
    await expect(f.manager.create(f.companyId, actor, { ...input, name: "Different" }, f.placement)).rejects.toMatchObject({ status: 409 });
    const action = { action: "stop" as const, expectedRevision: one.revision, requestId: randomUUID() };
    await f.manager.control(f.companyId, one.id, actor, action);
    const replay = await f.manager.control(f.companyId, one.id, actor, action);
    expect(replay.revision).toBe(one.revision + 1);
    await expect(f.manager.control(f.companyId, one.id, actor, { ...action, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(f.manager.get(randomUUID(), one.id)).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(replay)).not.toContain("node server.cjs");
  });

  it("persists the three-attempt crash budget across controller restarts", async () => {
    const f = await fixture();
    const service = await f.create({ purpose: "worker", endpoints: [], command: "node -e 'console.log(\"crash log\"); process.exit(1)'" });
    let result = service;
    for (let attempt = 0; attempt < 30 && result.state !== "failed"; attempt++) {
      await f.make().reconcile(f.companyId, service.id);
      await delay(50);
      clock = new Date(clock.getTime() + 8_000);
      result = await f.manager.get(f.companyId, service.id);
    }
    expect(result).toMatchObject({ state: "failed", restartCount: 3 });
    const revision = result.revision;
    await f.make().reconcile(f.companyId, service.id);
    expect((await f.manager.get(f.companyId, service.id)).revision).toBe(revision);
    expect(await f.manager.logs(f.companyId, service.id)).toContain("crash log");
  });

  it("keeps a stop received during provider launch authoritative", async () => {
    let resolveStarted!: () => void;
    let releaseLaunch!: () => void;
    const entered = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let running = false;
    let launches = 0;
    const provider: RuntimeServiceProvider = {
      key: "test", capabilities: { dynamicPorts: true, logs: true, preview: true, preservesDataOnStop: true },
      async inspect() { return { state: running ? "running" : "missing", endpoints: [] }; },
      async start(ctx) { launches++; resolveStarted(); await released; running = true; return ctx.process; },
      async stop() { running = false; }, async logs() { return ""; },
    };
    const f = await fixture(provider);
    const service = await f.create({ endpoints: [] });
    const first = f.manager.reconcile(f.companyId, service.id);
    await entered;
    const pending = await f.manager.get(f.companyId, service.id);
    await f.manager.control(f.companyId, service.id, actor, { action: "stop", expectedRevision: pending.revision, requestId: randomUUID() });
    await f.make().reconcile(f.companyId, service.id);
    releaseLaunch();
    await first;
    await f.make().reconcile(f.companyId, service.id);
    expect(launches).toBe(1);
    expect(running).toBe(false);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", desiredState: "stopped" });
    expect((await db.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, f.companyId), eq(runtimeServices.id, service.id))))[0]?.controllerId).toBeNull();
  });

  it("reports exposure failure separately from a healthy running application", async () => {
    const f = await fixture(undefined, { exposeEndpoint: async () => { throw new Error("upstream private-token-must-not-leak"); } });
    const service = await f.create();
    const running = await ready(f.manager, f.companyId, service.id);
    expect(running.endpoints[0]).toMatchObject({ health: "ready", status: "failed", url: null, verifiedAt: null });
    expect(JSON.stringify(running)).not.toContain("private-token-must-not-leak");
    expect(await (await fetch(`http://127.0.0.1:${running.endpoints[0]!.port}`)).text()).toBe("first uncommitted edit");
  });

  it("recovers transient status failures without restarting the application", async () => {
    let started = false;
    let disconnected = false;
    let launches = 0;
    const provider: RuntimeServiceProvider = {
      key: "transport", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { started = true; launches++; return ctx.process; },
      async inspect() {
        if (disconnected) throw new Error("provider transport timeout with private token");
        return { state: started ? "running" : "missing", endpoints: [] };
      },
      async stop() { started = false; }, async logs() { return ""; },
    };
    const f = await fixture(provider);
    const service = await f.create({ endpoints: [], purpose: "worker" });
    await ready(f.manager, f.companyId, service.id);
    disconnected = true;
    await f.manager.reconcile(f.companyId, service.id);
    const unavailable = await f.manager.get(f.companyId, service.id);
    expect(unavailable).toMatchObject({ state: "unhealthy", restartCount: 0 });
    expect(JSON.stringify(unavailable)).not.toContain("private token");
    disconnected = false;
    clock = new Date(clock.getTime() + 5001);
    await ready(f.make(), f.companyId, service.id);
    expect(launches).toBe(1);
  });

  it("does not relaunch an unidentified process when its supervisor journal disappears", async () => {
    const f = await fixture();
    const service = await f.create();
    const running = await ready(f.manager, f.companyId, service.id);
    const ref = (await f.manager.getRecord(f.companyId, service.id)).service.processRef!;
    const receipt = path.join(root, "supervisors", f.companyId, service.id, `${ref.generation}.json`);
    const saved = `${receipt}.saved`;
    await fs.rename(receipt, saved);
    try {
      await f.make().reconcile(f.companyId, service.id);
      expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "failed", error: expect.stringContaining("identity record is missing") });
      expect((await f.manager.getRecord(f.companyId, service.id)).service.processRef).toEqual(ref);
      expect(await (await fetch(`http://127.0.0.1:${running.endpoints[0]!.port}`)).text()).toBe("first uncommitted edit");
    } finally { await fs.rename(saved, receipt); }
  });
});
