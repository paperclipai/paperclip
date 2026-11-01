import { agents, applyPendingMigrations, companies, createDb, issues, routines, routineTriggers } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../services/delivery-work-notifications.js";
import { heartbeatService } from "../services/heartbeat.js";
import { routineService } from "../services/routines.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { registerScheduledWork } from "../services/scheduled-work.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SCHEDULED_WORK_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("scheduled deadline database queries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-deadlines");
    db = createDb(external ?? database.connectionString);
  }, 30_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("retains eligible overdue routines while excluding inactive and mismatched work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    const trigger = { companyId: company!.id, routineId: active!.id, kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" };
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
    } }, { retryMs: 60_000, tickAgentTimers: async () => {}, nextAgentTimerAt: async () => null, tickIssueMonitors: async () => {},
      nextIssueMonitorAt: () => heartbeatService(db).nextIssueMonitorAt(), tickRoutines: async () => {}, canRun: () => true,
      nextRoutineRunAt: () => routineService(db).nextScheduledTriggerAt() });
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    expect(await routineService(db).nextScheduledTriggerAt()).toBe(at(-1).getTime());
    expect(tasks.get(DELIVERY_QUEUES.routineSchedules)!.nextRunAt!()).toBeGreaterThan(now);
    expect(await heartbeatService(db).nextIssueMonitorAt()).toBe(at(-1).getTime());
    expect(tasks.get(DELIVERY_QUEUES.issueMonitors)!.nextRunAt!()).toBe(now + 60_000);
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.setSystemTime(at(2));
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    for (const task of tasks.values()) expect(task.nextRunAt!()).toBeNull();
  });
});
