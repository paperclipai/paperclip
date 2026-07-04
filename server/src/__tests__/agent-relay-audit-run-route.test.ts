import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping relay audit run route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("relay audit run route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-relay-audit-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("mints a terminal heartbeat run without wakeup or issue side effects", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RelayAgent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unrelated issue",
      identifier: "TST-1",
      status: "todo",
      assigneeAgentId: agentId,
    });

    const app = createApp(db, {
      type: "agent",
      source: "agent_key",
      agentId,
      companyId,
      runId: null,
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/relay-audit-run`)
      .send({
        triggerDetail: "callback",
        reason: "telegram_relay",
        payload: { channel: "telegram" },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      agentId,
      invocationSource: "relay_audit",
      triggerDetail: "callback",
      status: "succeeded",
      wakeupRequestId: null,
      exitCode: 0,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.startedAt).toEqual(expect.any(String));
    expect(res.body.finishedAt).toEqual(expect.any(String));
    expect(res.body.contextSnapshot).toMatchObject({
      source: "relay_audit",
      sideEffectFree: true,
      triggeredBy: "agent",
      actorId: agentId,
      payload: { channel: "telegram" },
    });

    const [heartbeatCount] = await db.select({ value: count() }).from(heartbeatRuns);
    const [wakeupCount] = await db.select({ value: count() }).from(agentWakeupRequests);
    const [activityCount] = await db.select({ value: count() }).from(activityLog);
    expect(heartbeatCount?.value).toBe(1);
    expect(wakeupCount?.value).toBe(0);
    expect(activityCount?.value).toBe(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
    expect(issue?.assigneeAgentId).toBe(agentId);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();
  });
});
