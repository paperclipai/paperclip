import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, routineRuns, routines, routineTriggers, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINES_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scheduled trigger failure isolation", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("routine-trigger-failures-");
    db = createDb(external ?? temporary!.connectionString);
  }, 30_000);
  afterEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate companies cascade`);
    });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seedFixture(options: { runtimeEnv: Record<string, string | undefined> }) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scheduled work",
      issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Scheduled agent",
      status: "active", lifecycleState: "ready", adapterType: "codex_local" });
    const wakeups: Array<{ agentId: string }> = [];
    const svc = routineService(db, { runtimeEnv: options.runtimeEnv,
      heartbeat: { wakeup: async (id) => { wakeups.push({ agentId: id }); return null; } } });
    const routine = await svc.create(companyId, { title: "Scheduled routine", assigneeAgentId: agentId,
      priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed", variables: [] }, {});
    return { routine, agentId, svc, wakeups };
  }

  it.each(["assignment", "variables"] as const)("continues to later scheduled triggers after %s validation fails", async (failure) => {
    const failed = await seedFixture({ runtimeEnv: {} });
    const healthy = await seedFixture({ runtimeEnv: {} });
    const { trigger: failedTrigger } = await failed.svc.createTrigger(failed.routine.id,
      { kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC" }, {});
    const { trigger: healthyTrigger } = await healthy.svc.createTrigger(healthy.routine.id,
      { kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC" }, {});
    if (failure === "assignment") {
      await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, failed.agentId));
    } else {
      await db.update(routines).set({ variables: [
        { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
      ] }).where(eq(routines.id, failed.routine.id));
    }
    const firstDue = new Date("2026-09-19T09:00:00Z");
    const now = new Date("2026-09-19T10:00:00Z");
    await db.update(routineTriggers).set({ nextRunAt: firstDue }).where(eq(routineTriggers.id, failedTrigger.id));
    await db.update(routineTriggers).set({ nextRunAt: now }).where(eq(routineTriggers.id, healthyTrigger.id));

    expect(await failed.svc.tickScheduledTriggers(now)).toEqual({ triggered: 1 });
    expect(failed.wakeups).toHaveLength(1);
    expect(failed.wakeups[0]?.agentId).toBe(healthy.agentId);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, failed.routine.id))).toHaveLength(0);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, healthy.routine.id)))
      .toMatchObject([{ status: "issue_created", triggerId: healthyTrigger.id }]);

    await db.update(routineTriggers).set({ nextRunAt: firstDue }).where(eq(routineTriggers.id, failedTrigger.id));
    await db.update(routineTriggers).set({ nextRunAt: now }).where(eq(routineTriggers.id, healthyTrigger.id));
    let candidates = 0;
    expect(await failed.svc.tickScheduledTriggers(now, () => ++candidates === 1)).toEqual({ triggered: 0 });
    const [unclaimed] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, healthyTrigger.id));
    expect(unclaimed!.nextRunAt).toEqual(now);
    expect(failed.wakeups).toHaveLength(1);
  });

});
