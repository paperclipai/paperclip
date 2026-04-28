import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("capacity guard routine scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-capacity-guard-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    if (db) {
      await db.delete(routineRuns);
      await db.delete(routineTriggers);
      await db.delete(routines);
      await db.delete(agents);
      await db.delete(companies);
    }
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.stop();
    }
  });

  it("should create skipped run when capacity is amber and routine is not critical", async () => {
    const svc = routineService(db);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const triggerId = randomUUID();

    // Create test data
    await db.insert(companies).values({ id: companyId, name: "Test Company" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "test",
    });

    const now = new Date();
    const nextRun = new Date(now.getTime() - 1000); // Past due

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Test Routine",
      status: "active",
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      capacityCritical: false, // NOT capacity critical
      assigneeAgentId: agentId,
    });

    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: true,
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      nextRunAt: nextRun,
    });

    // Execute tick - should skip due to capacity guard
    const result = await svc.tickScheduledTriggers(now);
    expect(result.triggered).toBe(0);

    // Verify skipped run record was created
    const runs = await db.select().from(routineRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.failureReason).toContain("capacity_band");
  });

  it("should dispatch routine when capacity_critical is true despite amber band", async () => {
    const svc = routineService(db);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const triggerId = randomUUID();

    // Create test data
    await db.insert(companies).values({ id: companyId, name: "Test Company" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "test",
    });

    const now = new Date();
    const nextRun = new Date(now.getTime() - 1000);

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Critical Routine",
      status: "active",
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      capacityCritical: true, // IS capacity critical
      assigneeAgentId: agentId,
    });

    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: true,
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      nextRunAt: nextRun,
    });

    // Execute tick - should dispatch because routine is capacity_critical
    const result = await svc.tickScheduledTriggers(now);
    expect(result.triggered).toBe(1);

    // Verify dispatched run record was created (not skipped)
    const runs = await db.select().from(routineRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).not.toBe("skipped");
  });
});
