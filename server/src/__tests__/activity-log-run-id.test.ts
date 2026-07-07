import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity-log run id tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// TWX-1253: activity_log.run_id is a uuid FK to heartbeat_runs.id. Synthetic
// heartbeat run ids ("ceo-heartbeat") and valid-but-unpersisted run uuids used to
// 500 the originating write (invalid uuid cast / foreign key violation). logActivity
// must resolve those to null instead of throwing.
describeEmbeddedPostgres("logActivity run id resolution (TWX-1253)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-run-id-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  function logInput(runId: string | null) {
    return {
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      action: "issue_comment_added",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId,
    };
  }

  it("nulls a non-uuid synthetic run id instead of throwing", async () => {
    await seedCompanyAndAgent();
    await expect(logActivity(db, logInput("ceo-heartbeat"))).resolves.not.toThrow();
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBeNull();
  });

  it("nulls a valid uuid with no matching heartbeat_runs row instead of a FK violation", async () => {
    await seedCompanyAndAgent();
    await expect(logActivity(db, logInput(randomUUID()))).resolves.not.toThrow();
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBeNull();
  });

  it("keeps a real persisted run id", async () => {
    await seedCompanyAndAgent();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });
    await logActivity(db, logInput(runId));
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe(runId);
  });
});
