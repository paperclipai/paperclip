import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity-log resilience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("logActivity post-commit resilience (PLA-9)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-resilience-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not throw when runId references a non-existent heartbeat run", async () => {
    // This is the exact bug from PLA-9: a request carrying an X-Paperclip-Run-Id
    // header whose value is not a real heartbeat_runs.id used to make logActivity
    // throw a FK violation. Because logActivity ran AFTER the route's side
    // effect already committed, callers got a 500, retried, and produced
    // duplicate writes (e.g. 5 duplicate BizOps agents).
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const danglingRunId = randomUUID();

    await expect(
      logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: randomUUID(),
        action: "test.regression.pla9",
        entityType: "agent",
        entityId: randomUUID(),
        agentId: null,
        runId: danglingRunId,
        details: { note: "dangling run id should not fail the request" },
      }),
    ).resolves.toBeUndefined();
  });

  it("writes the row when the runId is null", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "board",
      action: "test.regression.pla9.null-run",
      entityType: "company",
      entityId: companyId,
      runId: null,
    });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      action: "test.regression.pla9.null-run",
      runId: null,
    });
  });
});
