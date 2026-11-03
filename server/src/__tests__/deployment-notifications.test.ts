import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { enableDatabaseWorkNotifications, publishDatabaseWorkHint, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { deploymentNotifications } from "../services/deployment-notifications.js";
import { setNativeExecutionActive } from "../services/native-runtime/native-active-runs.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let a: ReturnType<typeof createDb>, b: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("deployment-notifications-");
  a = createDb(database.connectionString); b = createDb(database.connectionString);
  enableDatabaseWorkNotifications(b);
  await a.execute(sql`create table deployment_notification_fixture (id text primary key)`);
}, 90_000);
afterAll(async () => { await a?.$client.end({ timeout: 1 }); await b?.$client.end({ timeout: 1 }); await database?.cleanup(); });
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Notification condition did not settle"); await delay(10); }
}
async function open(handoffMs = 120_000) {
  const errors: unknown[] = [];
  const coordinator = createDeliveryWorkCoordinator({ owner: a, canRun: () => true, onError: error => errors.push(error) });
  const bridge = deploymentNotifications(a, coordinator, { directDatabaseUrl: database.connectionString, handoffMs });
  await bridge.ready();
  return { bridge, errors, async stop() { await bridge.stop(); await coordinator.stop(); } };
}
async function listenerCount() {
  const [row] = await b.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
    where datname = current_database() and application_name = 'paperclip-deployment-notifications'`);
  return row!.count;
}

it("delivers committed hints across independent pools, without exposing an outer rollback or nested savepoint", async () => {
  const fixture = await open();
  const observed: number[] = [];
  const topic = `test-${randomUUID()}`;
  const unsubscribe = subscribeDatabaseWork(a, topic, () => {
    void a.execute(sql`select id from deployment_notification_fixture`).then(rows => observed.push(rows.length));
  });
  try {
    await b.transaction(async outer => {
      await outer.transaction(async nested => {
        await signalDatabaseWork(nested, topic);
        await nested.execute(sql`insert into deployment_notification_fixture values ('committed')`);
      });
      expect(observed).toEqual([]);
    });
    await eventually(async () => observed.length === 1);
    expect(observed).toEqual([1]);
    await expect(b.transaction(async tx => {
      await signalDatabaseWork(tx, topic);
      await tx.execute(sql`insert into deployment_notification_fixture values ('rollback')`);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    let barrier = false;
    const stopBarrier = subscribeDatabaseWork(a, "test-barrier", () => { barrier = true; });
    await publishDatabaseWorkHint(b, "test-barrier");
    await eventually(async () => barrier); stopBarrier();
    expect(observed).toEqual([1]);
    expect(fixture.errors).toEqual([]);
  } finally { unsubscribe(); await fixture.stop(); }
});

it("reconstructs on listener reconnect and scopes live refresh hints to the company", async () => {
  const fixture = await open();
  let refreshed = 0, other = 0, reconstructed = 0;
  const companyId = randomUUID();
  const stopCompany = fixture.bridge.subscribeCompany(companyId, () => { refreshed++; });
  const stopOther = fixture.bridge.subscribeCompany(randomUUID(), () => { other++; });
  const stopQueue = subscribeDatabaseWork(a, "test-reconstruction", () => { reconstructed++; });
  try {
    await publishDatabaseWorkHint(b, `live:${companyId}`);
    await eventually(async () => refreshed === 1);
    expect(other).toBe(0);
    await b.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database()
      and application_name = 'paperclip-deployment-notifications'`);
    await eventually(async () => reconstructed > 0);
    // Reconnect cannot know which hints were lost, so it refreshes both company
    // subscriptions and existing durable queue consumers once.
    expect(other).toBeGreaterThan(0);
  } finally { stopCompany(); stopOther(); stopQueue(); await fixture.stop(); }
});

it("disconnects at the handoff deadline, reopens for active execution and becomes quiet again", async () => {
  const fixture = await open(25), runId = randomUUID();
  const stopCompany = fixture.bridge.subscribeCompany(randomUUID(), () => {});
  try {
    expect(await listenerCount()).toBe(1);
    fixture.bridge.markReady();
    await eventually(async () => await listenerCount() === 0);
    setNativeExecutionActive(runId, true);
    await eventually(async () => await listenerCount() === 1);
    setNativeExecutionActive(runId, false);
    await eventually(async () => await listenerCount() === 0);
    expect(fixture.errors).toEqual([]);
  } finally { setNativeExecutionActive(runId, false); stopCompany(); await fixture.stop(); }
});
