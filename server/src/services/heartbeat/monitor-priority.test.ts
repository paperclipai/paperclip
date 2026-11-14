import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatScheduling, type HeartbeatSchedulingDependencies } from "./scheduling.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("monitor sweep priority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("monitor-priority");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  it.each(["tickTimers", "tickIssueMonitors"] as const)("dispatches by priority with stable due order (%s)", async operation => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const [company] = await db.insert(companies).values({ name: "Priority", issuePrefix: "PRI" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Monitor agent", adapterType: "paperclip_runner" }).returning();
    const monitors = [];
    for (const [index, priority] of ["low", "medium", "high", "high", "critical"].entries()) {
      const at = new Date(now.getTime() - 60_000 + index * 1000);
      const [monitor] = await db.insert(issues).values({
        companyId: company.id, title: `Check ${priority} deployment ${index}`, status: "in_progress",
        assigneeAgentId: agent.id, priority, monitorNextCheckAt: at,
        executionPolicy: { monitor: { nextCheckAt: at.toISOString() } },
      }).returning();
      monitors.push(monitor!);
    }
    const state = createHeartbeatRunState(db);
    const preparation = createHeartbeatRunPreparation(db);
    const enqueueWakeup = vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () => ({ id: "admitted" }) as typeof heartbeatRuns.$inferSelect);
    const scheduler = createHeartbeatScheduling(db, {
      getAgent: state.getAgent, getRun: state.getRun,
      toAgentOrgRow: preparation.toAgentOrgRow, groupAgentOrgRowsByCompany: preparation.groupAgentOrgRowsByCompany,
      issuesSvc: { listReviewAttention: vi.fn(async () => new Map()), create: vi.fn() },
      enqueueWakeup, scheduleBoundedRetryForRun: vi.fn(),
      getSchedulingSuppression: async () => ({ suppressed: false }),
      getWorktreeExecutionCutoff: async () => null,
      parseHeartbeatPolicy: () => ({ enabled: false, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 2,
        skipTimerWhenNoActionableWork: false, maxDailyRuns: null, maxDailyCostCents: null }),
      nextTimerHeartbeatAt: vi.fn(), claimDueTimerHeartbeat: vi.fn(),
    });
    await scheduler[operation](now);
    expect(enqueueWakeup.mock.calls.map(call => call[1]?.payload?.issueId)).toEqual([
      monitors[4]!.id, monitors[2]!.id, monitors[3]!.id, monitors[1]!.id, monitors[0]!.id,
    ]);
    expect(await db.select({ attempts: issues.monitorAttemptCount, nextCheck: issues.monitorNextCheckAt }).from(issues))
      .toEqual(Array.from({ length: 5 }, () => ({ attempts: 1, nextCheck: null })));
  });
});
