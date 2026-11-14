import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, routineRuns, routines, routineTriggers } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINE_SCHEDULER_FAILURES_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("routine scheduler failure isolation", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("routine-scheduler-failures-");
    db = createDb(externalUrl ?? temporary!.connectionString);
  }, 30_000);
  afterEach(async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate companies cascade`);
    });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it.each(["assignment", "variables"])("dispatches later triggers after %s validation fails", async failure => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scheduled work", issuePrefix: `R${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Scheduled agent", status: "active", lifecycleState: "ready", adapterType: "codex_local" });
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    const svc = routineService(db, { heartbeat: { wakeup }, runtimeEnv: {} });
    const failing = await svc.create(companyId, {
      title: "Failing routine", assigneeAgentId: agentId, priority: "medium", status: "active",
      concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [],
    }, {});
    const healthy = await svc.create(companyId, {
      title: "Healthy routine", assigneeAgentId: agentId, priority: "medium", status: "active",
      concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [],
    }, {});
    const { trigger: failingTrigger } = await svc.createTrigger(failing.id, {
      kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC",
    }, {});
    const { trigger: healthyTrigger } = await svc.createTrigger(healthy.id, {
      kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC",
    }, {});
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-07-16T00:00:00Z") })
      .where(eq(routineTriggers.id, failingTrigger.id));
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-07-16T01:00:00Z") })
      .where(eq(routineTriggers.id, healthyTrigger.id));
    if (failure === "assignment") {
      const terminatedAgentId = randomUUID();
      await db.insert(agents).values({ id: terminatedAgentId, companyId, name: "Terminated agent", status: "terminated", adapterType: "codex_local" });
      await db.update(routines).set({ assigneeAgentId: terminatedAgentId }).where(eq(routines.id, failing.id));
    } else {
      await db.update(routines).set({
        variables: [{ name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] }],
      }).where(eq(routines.id, failing.id));
    }

    expect(await svc.tickScheduledTriggers(new Date("2026-07-16T01:05:00Z"))).toEqual({ triggered: 1 });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, failing.id))).toHaveLength(0);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, healthy.id)))
      .toMatchObject([{ status: "issue_created", triggerId: healthyTrigger.id }]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
