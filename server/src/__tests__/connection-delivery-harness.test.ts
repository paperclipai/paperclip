import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, createDb, issueThreadInteractions } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;
const created = vi.hoisted(() => ({
  coordinators: [] as Array<{ real: Coordinator; stopped: boolean }>,
  nextWakeAtFailure: null as Error | null,
}));

vi.mock("../services/delivery-work-coordinator.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/delivery-work-coordinator.js")>();
  return {
    ...actual,
    createDeliveryWorkCoordinator: (input: Parameters<typeof actual.createDeliveryWorkCoordinator>[0]) => {
      const record = { real: actual.createDeliveryWorkCoordinator(input), stopped: false };
      created.coordinators.push(record);
      return {
        ...record.real,
        nextWakeAt: () => {
          const failure = created.nextWakeAtFailure;
          created.nextWakeAtFailure = null;
          if (failure) throw failure;
          return record.real.nextWakeAt();
        },
        async stop() {
          await record.real.stop();
          record.stopped = true;
        },
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("connection delivery harness lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-connection-delivery-harness-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  afterEach(async () => {
    created.nextWakeAtFailure = null;
    await Promise.all(created.coordinators.splice(0).map(record => record.real.stop()));
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  function expectReleased(activeBefore: number) {
    expect(created.coordinators).toHaveLength(1);
    const [record] = created.coordinators;
    expect(record!.stopped).toBe(true);
    expect(record!.real.nextWakeAt()).toBeNull();
    expect(() => record!.real.register(DELIVERY_QUEUES.connection, { retryMs: 1, run: async () => undefined, hasPending: async () => false }))
      .toThrow("Delivery coordinator is stopped");
    expect(idleWorkSnapshot().active).toBe(activeBefore);
  }

  it("stops the coordinator and propagates the original error when worker.ready rejects", async () => {
    const activeBefore = idleWorkSnapshot().active;
    const failure = new Error("canRun failed during startup");
    await expect(startConnectionDelivery(db, { canRun: () => { throw failure; } })).rejects.toBe(failure);
    expectReleased(activeBefore);
  });

  it("stops the coordinator and propagates the original error when the initial settle rejects", async () => {
    const activeBefore = idleWorkSnapshot().active;
    const failure = new Error("quiescence check failed during startup");
    created.nextWakeAtFailure = failure;
    await expect(startConnectionDelivery(db)).rejects.toBe(failure);
    expect(created.nextWakeAtFailure).toBeNull();
    expectReleased(activeBefore);
  });

  it("returns a working delivery whose cleanup stops the coordinator", async () => {
    const seeded = await seedPendingAccessRequest(db, "owner");
    expect(await db.select().from(issueThreadInteractions)).toEqual([expect.objectContaining({ id: seeded.intent.id, status: "pending" })]);
    const activeBefore = idleWorkSnapshot().active;
    const beforeSweep = vi.fn().mockResolvedValue(undefined);
    const delivery = await startConnectionDelivery(db, { beforeSweep });
    expect(delivery.sweeps).toBeGreaterThanOrEqual(1);
    expect(created.coordinators[0]!.stopped).toBe(false);
    const baseline = delivery.sweeps;
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect(delivery.sweeps).toBe(baseline + 1);
    expect(beforeSweep).toHaveBeenCalledTimes(delivery.sweeps);
    await delivery.stop();
    expectReleased(activeBefore);
  });
});
