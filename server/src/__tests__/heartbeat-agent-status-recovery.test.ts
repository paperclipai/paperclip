import { randomUUID } from "node:crypto";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping assembled agent status recovery: ${support.reason}`);

describePostgres("heartbeat recovery of a stranded agent", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-status-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  it("repairs shutdown state through the existing reaper and permits a quiet idle proof", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const old = new Date(Date.now() - 60 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Recovery fixture", issuePrefix: "RCVR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
      status: "running", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false } },
      updatedAt: old, lastHeartbeatAt: null });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "interrupted", runtimeMode: "legacy", invocationSource: "automation",
      errorCode: "server_shutdown_interrupted", startedAt: old, finishedAt: old, updatedAt: old });
    const now = Date.now();
    const ownerId = randomUUID();
    const drain = () => ({ ownerId, draining: true, startedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
    const inspect = () => readIdleSleepSafety(db, drain, () => now, ownerId, async () => "none");
    expect(await inspect()).toEqual({ version: 1, backgroundWork: "present" });

    const service = heartbeatService(db);
    expect(await service.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(await db.select().from(agents).where(eq(agents.id, agentId)))
      .toEqual([expect.objectContaining({ status: "idle", lastHeartbeatAt: null })]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))
      .toEqual([expect.objectContaining({ status: "interrupted", errorCode: "server_shutdown_interrupted" })]);
    expect(await inspect()).toEqual({ version: 1, backgroundWork: "none" });

    const replacement = heartbeatService(db);
    expect(await replacement.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(await inspect()).toEqual({ version: 1, backgroundWork: "none" });
  });

  it("keeps unrelated recovery available when the correction audit fails", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    const old = new Date(Date.now() - 60 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Audit failure", issuePrefix: "ADTF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
      status: "running", adapterType: "process", updatedAt: old });
    await db.execute(sql`ALTER TABLE activity_log ADD CONSTRAINT reject_status_repair CHECK (action <> 'agent.status_reconciled') NOT VALID`);
    const service = heartbeatService(db);
    try {
      expect(await service.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
      expect(await db.select().from(agents).where(eq(agents.id, agentId)))
        .toEqual([expect.objectContaining({ status: "running" })]);
    } finally {
      await db.execute(sql`ALTER TABLE activity_log DROP CONSTRAINT reject_status_repair`);
    }
    expect(await service.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
    expect(await db.select().from(agents).where(eq(agents.id, agentId)))
      .toEqual([expect.objectContaining({ status: "idle" })]);
  });
});
