import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent JWT activity-log tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent JWT activity log run_id handling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-jwt-activity-log-");
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

  async function seedActorAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("drops a non-persisted run id instead of violating the activity_log heartbeat FK", async () => {
    const { companyId, agentId } = await seedActorAgent();
    const invalidRunId = randomUUID();

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: invalidRunId,
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
      details: { source: "agent_jwt" },
    });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.created",
      runId: null,
    });
  });

  it("preserves a persisted heartbeat run id for activity rows", async () => {
    const { companyId, agentId } = await seedActorAgent();
    const persistedRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: persistedRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "queued",
      triggerDetail: "manual",
    });

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: persistedRunId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: persistedRunId,
      details: { source: "agent_jwt" },
    });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "heartbeat.invoked",
      runId: persistedRunId,
    });
  });

  it("skips the heartbeat lookup when callers mark the run id as verified", async () => {
    const { companyId, agentId } = await seedActorAgent();
    const persistedRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: persistedRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "queued",
      triggerDetail: "manual",
    });

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: persistedRunId,
      runIdVerified: true,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: persistedRunId,
      details: { source: "verified_run" },
    });

    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "heartbeat.invoked",
      runId: persistedRunId,
    });
  });
});
