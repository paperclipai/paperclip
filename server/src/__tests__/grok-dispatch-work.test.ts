import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, grokBotDispatches } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { grokRoutineFixture } from "./helpers/grok-routine-fixture.js";
import { createGrokRoutineDispatcher } from "../services/grok-bot/dispatcher.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { grokRoutineService } from "../services/grok-bot/routine.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_GROK_DISPATCH_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Grok dispatch worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof createGrokRoutineDispatcher>;
  let draining: boolean;
  const errors: unknown[] = [];
  const delivery = vi.fn(async () => ({ delivery: "accepted" as const, httpStatus: 200 }));
  const enable = (enableGrokBot = true) => instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableNativeRunner: true, enableGrokBot });
  const reserve = (f: Awaited<ReturnType<typeof grokRoutineFixture>>, database = db) => grokRoutineService(database, delivery).reserve({
    companyId: f.company.id, agentId: f.agent.id, bindingId: f.pairing.bindingId, sourceEventId: randomUUID(), kind: "verify",
  });
  const status = async (id: string) => (await db.select().from(grokBotDispatches).where(eq(grokBotDispatches.id, id)))[0]?.status;

  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("grok-dispatch-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 120_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await db.delete(grokBotDispatches);
    await enable();
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    draining = false; errors.length = 0; delivery.mockReset();
    delivery.mockResolvedValue({ delivery: "accepted", httpStatus: 200 });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    worker = createGrokRoutineDispatcher(db, () => !draining, delivery);
    await worker.start(coordinator).ready;
  }
  async function quiet() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function delivered(id: string) {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(await status(id)).toBe("accepted"); }, { timeout: 5000 });
  }

  it("does not query every second with Grok disabled", async () => {
    await enable(false); await start(); await quiet(); expect(delivery).not.toHaveBeenCalled();
  });
  it("is quiet when configured and wakes from the real reservation", async () => {
    const f = await grokRoutineFixture(db); await start(); await quiet();
    const row = await reserve(f); await delivered(row.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it("reconstructs prepared work on restart", async () => {
    const f = await grokRoutineFixture(db); const row = await reserve(f);
    await start(); await delivered(row.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it.each(["sending", "accepted", "unknown", "acknowledged", "rejected", "cancelled"] as const)("does not replay %s history", async state => {
    const f = await grokRoutineFixture(db); const row = await reserve(f);
    await db.update(grokBotDispatches).set({ status: state }).where(eq(grokBotDispatches.id, row.id));
    await start(); await quiet(); expect(await status(row.id)).toBe(state); expect(delivery).not.toHaveBeenCalled();
  });
  it("keeps disabled prepared work quiet and wakes from committed settings", async () => {
    const f = await grokRoutineFixture(db); const row = await reserve(f); await enable(false);
    await start(); await quiet(); expect(await status(row.id)).toBe("prepared");
    await enable(); await delivered(row.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("waits for the outer transaction, commit=%s", async commit => {
    const f = await grokRoutineFixture(db); await start(); await quiet();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let created!: Awaited<ReturnType<typeof reserve>>;
    const transaction = db.transaction(async tx => {
      created = await reserve(f, tx as unknown as typeof db); await held;
      if (!commit) throw new Error("rollback fixture");
    }).catch(error => { if (commit || error.message !== "rollback fixture") throw error; });
    await vi.waitFor(() => expect(created).toBeDefined());
    await vi.advanceTimersByTimeAsync(2000); expect(delivery).not.toHaveBeenCalled();
    release(); await transaction;
    if (commit) await delivered(created.id);
    else expect(await status(created.id)).toBeUndefined();
    await quiet(); expect(delivery).toHaveBeenCalledTimes(commit ? 1 : 0);
  });
  it.each(["startup", "first write"] as const)("preserves %s during drain without passive SQL", async when => {
    const f = await grokRoutineFixture(db);
    if (when === "first write") { await start(); await quiet(); }
    draining = true; const row = await reserve(f); if (when === "startup") await start();
    await vi.advanceTimersByTimeAsync(2000); await vi.waitFor(() => expect(idleWorkSnapshot().active).toBeLessThanOrEqual(1));
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(10_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    expect(delivery).not.toHaveBeenCalled(); draining = false;
    await delivered(row.id); await quiet();
  });
  it("retains a failed scan through drain and resumes its retry", async () => {
    const f = await grokRoutineFixture(db); await start(); await quiet();
    draining = true; const row = await reserve(f);
    const read = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("scan unavailable"); });
    draining = false; await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors).toHaveLength(1); });
    read.mockRestore(); draining = true; errors.length = 0;
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(10_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    draining = false; await delivered(row.id); await quiet();
  });
  it("preserves an enqueue during provider delivery", async () => {
    const first = await grokRoutineFixture(db), second = await grokRoutineFixture(db);
    await start(); await quiet(); let next!: Awaited<ReturnType<typeof reserve>>;
    delivery.mockImplementationOnce(async () => { next = await reserve(second); return { delivery: "accepted", httpStatus: 200 }; });
    const row = await reserve(first); await delivered(row.id); await vi.waitFor(() => expect(next).toBeDefined());
    await delivered(next.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(2);
  });
  it("drains more than one page then stops with retained history", async () => {
    const rows = [];
    for (let i = 0; i < 11; i++) rows.push(await reserve(await grokRoutineFixture(db)));
    await start(); await delivered(rows.at(-1)!.id); await quiet();
    expect(delivery).toHaveBeenCalledTimes(11);
    expect((await db.select().from(grokBotDispatches)).every(row => row.status === "accepted")).toBe(true);
  });
  it("shares the durable claim with a simultaneous foreground send", async () => {
    const f = await grokRoutineFixture(db); await start(); await quiet();
    const row = await reserve(f);
    await Promise.all([grokRoutineService(db, delivery).send(f.company.id, f.agent.id, row.id), worker.tick()]);
    await delivered(row.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it("cancels an expired unsent dispatch without contacting the provider", async () => {
    const f = await grokRoutineFixture(db); const row = await reserve(f);
    await db.update(grokBotDispatches).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(grokBotDispatches.id, row.id));
    await start(); await quiet(); expect(await status(row.id)).toBe("cancelled"); expect(delivery).not.toHaveBeenCalled();
  });
  it("does not enable pending dispatches before the settings transaction commits", async () => {
    const f = await grokRoutineFixture(db); const row = await reserve(f); await enable(false);
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await instanceSettingsService(tx as unknown as typeof db).updateExperimental({ enableGrokBot: true });
      await vi.advanceTimersByTimeAsync(2000); expect(delivery).not.toHaveBeenCalled(); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await status(row.id)).toBe("prepared");
    await db.transaction(async tx => {
      await instanceSettingsService(tx as unknown as typeof db).updateExperimental({ enableGrokBot: true });
      await vi.advanceTimersByTimeAsync(2000); expect(delivery).not.toHaveBeenCalled();
    });
    await delivered(row.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it("joins an admitted send on shutdown and leaves later rows for restart", async () => {
    const first = await grokRoutineFixture(db), second = await grokRoutineFixture(db);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    delivery.mockImplementationOnce(async () => { await held; return { delivery: "accepted", httpStatus: 200 }; });
    const one = await reserve(first); const two = await reserve(second);
    const starting = start(); await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2000); expect(stopped).toBe(false);
    release(); await stopping; await starting;
    expect(await status(one.id)).toBe("accepted"); expect(await status(two.id)).toBe("prepared");
    await start(); await delivered(two.id); await quiet(); expect(delivery).toHaveBeenCalledTimes(2);
  });
});
