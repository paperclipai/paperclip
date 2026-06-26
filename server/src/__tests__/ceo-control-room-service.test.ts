import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ceoControlRoomService } from "../services/ceo-control-room.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CEO control-room tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ceo control-room operational loop incidents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ceo-control-room-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutine() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ops Bot",
      role: "general",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Market data liveness",
      description: "Check market data freshness",
      assigneeAgentId: agentId,
      priority: "high",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: true,
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    });

    return { companyId, routineId, triggerId };
  }

  it("dedupes repeated operational-loop reports into one fingerprinted incident", async () => {
    const { companyId, routineId, triggerId } = await seedRoutine();
    const svc = ceoControlRoomService(db);

    const first = await svc.createOrUpdateOperationalIncident(companyId, {
      routineId,
      routineTitle: "Market data liveness",
      note: "first noisy watchdog report",
    });
    await db
      .update(routines)
      .set({ title: "Market data liveness renamed" })
      .where(eq(routines.id, routineId));

    const second = await svc.createOrUpdateOperationalIncident(companyId, {
      routineId,
      routineTitle: "Market data liveness renamed",
      note: "same routine reported again",
    });

    expect(second.issue.id).toBe(first.issue.id);
    expect(second.routine).toEqual({
      id: routineId,
      title: "Market data liveness renamed",
      status: "paused",
    });

    const incidentRows = await db
      .select({
        id: issues.id,
        title: issues.title,
        status: issues.status,
        originKind: issues.originKind,
        originId: issues.originId,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "operational_loop_incident")));

    expect(incidentRows).toEqual([
      expect.objectContaining({
        id: first.issue.id,
        title: "Operational incident: Market data liveness",
        status: "blocked",
        originId: routineId,
        originFingerprint: `operational-loop:routine:${routineId}`,
      }),
    ]);

    await expect(
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, first.issue.id)),
    ).resolves.toHaveLength(1);

    await expect(
      db
        .select({
          status: routines.status,
        })
        .from(routines)
        .where(eq(routines.id, routineId)),
    ).resolves.toEqual([{ status: "paused" }]);

    await expect(
      db
        .select({
          enabled: routineTriggers.enabled,
          lastResult: routineTriggers.lastResult,
        })
        .from(routineTriggers)
        .where(eq(routineTriggers.id, triggerId)),
    ).resolves.toEqual([
      {
        enabled: false,
        lastResult: "Paused by CEO Operations: durable incident owns this watchdog loop",
      },
    ]);
  });
});
