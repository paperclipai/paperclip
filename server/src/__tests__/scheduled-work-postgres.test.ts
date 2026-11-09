import { agents, companies, createDb, issues, routines, routineTriggers } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../services/delivery-work-notifications.js";
import { registerScheduledWork } from "../services/scheduled-work.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("scheduled deadline database queries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-deadlines");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("selects future eligible deadlines and excludes inactive, mismatched and past work", async () => {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000);
    const [company, pausedCompany] = await db.insert(companies).values([
      { name: "Active schedules", issuePrefix: "SCH" },
      { name: "Paused schedules", issuePrefix: "PAU", status: "paused" },
    ]).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Scheduled agent" }).returning();
    const [active, paused, otherCompany] = await db.insert(routines).values([
      { companyId: company!.id, title: "Active routine" },
      { companyId: company!.id, title: "Paused routine", status: "paused" },
      { companyId: pausedCompany!.id, title: "Paused company routine" },
    ]).returning();
    const trigger = { companyId: company!.id, routineId: active!.id, kind: "schedule" };
    await db.insert(routineTriggers).values([
      { ...trigger, nextRunAt: at(10) },
      { ...trigger, enabled: false, nextRunAt: at(1) },
      { ...trigger, archived: true, nextRunAt: at(2) },
      { ...trigger, routineId: paused!.id, nextRunAt: at(3) },
      { ...trigger, companyId: pausedCompany!.id, nextRunAt: at(4) },
      { ...trigger, companyId: pausedCompany!.id, routineId: otherCompany!.id, nextRunAt: at(5) },
      { ...trigger, nextRunAt: at(-1) },
    ]);
    const monitor = { companyId: company!.id, title: "Monitor", status: "in_progress", assigneeAgentId: agent!.id };
    await db.insert(issues).values([
      { ...monitor, monitorNextCheckAt: at(15) },
      { ...monitor, status: "done", monitorNextCheckAt: at(1) },
      { ...monitor, assigneeUserId: "fixture-user", monitorNextCheckAt: at(2) },
      { ...monitor, assigneeAgentId: null, monitorNextCheckAt: at(3) },
      { ...monitor, companyId: pausedCompany!.id, monitorNextCheckAt: at(4) },
      { ...monitor, monitorNextCheckAt: at(-1) },
    ]);
    type Task = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    const tasks = new Map<DeliveryQueue, Task>();
    registerScheduledWork({ register: (queue, task) => {
      tasks.set(queue, task);
      return { ready: Promise.resolve(), wake: () => {} };
    } }, db, { retryMs: 60_000, tickTimers: async () => {}, tickRoutines: async () => {} });
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    expect(tasks.get(DELIVERY_QUEUES.routineSchedules)!.nextRunAt!()).toBe(at(10).getTime());
    expect(tasks.get(DELIVERY_QUEUES.issueMonitors)!.nextRunAt!()).toBe(at(15).getTime());
    await db.execute(sql`truncate table companies restart identity cascade`);
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    for (const task of tasks.values()) expect(task.nextRunAt!()).toBeNull();
  });
});
