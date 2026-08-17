import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAccessGrants,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("heartbeat run privacy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-privacy-routes-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueAccessGrants);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const grantedAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const otherUserId = `other-${randomUUID()}`;
    const issueId = randomUUID();
    const privateRunId = randomUUID();
    const maintenanceRunId = randomUUID();
    const operationId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Run Privacy",
      issuePrefix: "RPR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([ownerUserId, otherUserId].map((id) => ({
      id,
      name: id === ownerUserId ? "Owner user" : "Other user",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })));
    await db.insert(companyMemberships).values([ownerUserId, otherUserId].map((principalId) => ({
      companyId,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: "operator",
    })));
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Owner",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: grantedAgentId,
        companyId,
        name: "Granted reviewer",
        role: "security",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RPR-1",
      title: "Confidential email triage",
      description: "private@example.test",
      visibility: "private",
      privacyRootIssueId: issueId,
      status: "in_progress",
      responsibleUserId: ownerUserId,
      assigneeAgentId: ownerAgentId,
    });
    await db.insert(issueAccessGrants).values({
      issueId,
      subjectType: "agent",
      subjectId: grantedAgentId,
      source: "explicit",
      grantedByAgentId: ownerAgentId,
    });

    const startedAt = new Date("2026-07-31T12:00:00.000Z");
    const finishedAt = new Date("2026-07-31T12:01:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: privateRunId,
        companyId,
        agentId: ownerAgentId,
        scopeKind: "issue",
        issueId,
        invocationSource: "assignment",
        status: "running",
        startedAt,
        finishedAt,
        usageJson: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 },
        resultJson: { summary: "Read the confidential email", costUsd: 0.42 },
        contextSnapshot: { issueId, title: "Confidential email triage" },
        logStore: "local_file",
        logRef: "missing-private-run-log.ndjson",
      },
      {
        id: maintenanceRunId,
        companyId,
        agentId: ownerAgentId,
        scopeKind: "company",
        issueId: null,
        invocationSource: "timer",
        status: "succeeded",
        startedAt,
        finishedAt,
        resultJson: { summary: "Maintenance complete", costUsd: 0.01 },
        contextSnapshot: { wakeReason: "heartbeat_timer" },
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: privateRunId,
      agentId: ownerAgentId,
      seq: 1,
      eventType: "output",
      stream: "stdout",
      message: "private@example.test",
    });
    await db.insert(workspaceOperations).values({
      id: operationId,
      companyId,
      heartbeatRunId: privateRunId,
      issueId: null,
      phase: "provision",
      status: "succeeded",
      command: "read private email",
      stdoutExcerpt: "private@example.test",
      logStore: "local_file",
      logRef: "missing-private-operation-log.ndjson",
    });

    return {
      companyId,
      ownerAgentId,
      grantedAgentId,
      otherAgentId,
      ownerUserId,
      otherUserId,
      issueId,
      privateRunId,
      maintenanceRunId,
      operationId,
    };
  }

  function createApp(companyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(companyId: string, userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("returns 404 for direct private-run content and metadata-only list stubs to a non-member", async () => {
    const fixture = await seedFixture();
    const app = createApp(fixture.companyId, fixture.otherAgentId);

    for (const path of [
      `/api/heartbeat-runs/${fixture.privateRunId}`,
      `/api/heartbeat-runs/${fixture.privateRunId}/events`,
      `/api/heartbeat-runs/${fixture.privateRunId}/log`,
      `/api/heartbeat-runs/${fixture.privateRunId}/workspace-operations`,
      `/api/workspace-operations/${fixture.operationId}/log`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("private@example.test");
    }

    const history = await request(app).get(`/api/companies/${fixture.companyId}/heartbeat-runs`);
    expect(history.status).toBe(200);
    const privateStub = history.body.find((run: { id: string }) => run.id === fixture.privateRunId);
    expect(privateStub).toMatchObject({
      redacted: true,
      durationMs: 60_000,
      costUsd: 0.42,
      usageJson: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 },
    });
    expect(privateStub).not.toHaveProperty("issueId");
    expect(privateStub).not.toHaveProperty("contextSnapshot");
    expect(privateStub).not.toHaveProperty("resultJson");
    expect(JSON.stringify(privateStub)).not.toContain("Confidential email triage");
    expect(JSON.stringify(privateStub)).not.toContain("summary");

    const summarizedHistory = await request(app)
      .get(`/api/companies/${fixture.companyId}/heartbeat-runs?summary=true`);
    const summarizedStub = summarizedHistory.body.find((run: { id: string }) => run.id === fixture.privateRunId);
    expect(summarizedStub).toMatchObject({ redacted: true, durationMs: 60_000, costUsd: 0.42 });
    expect(summarizedStub.usageJson).toMatchObject({ inputTokens: 11, outputTokens: 7 });

    const live = await request(app).get(`/api/companies/${fixture.companyId}/live-runs`);
    expect(live.status).toBe(200);
    expect(live.body[0]).toMatchObject({ id: fixture.privateRunId, redacted: true, costUsd: 0.42 });
    expect(live.body[0]).not.toHaveProperty("issueId");

    const maintenance = await request(app).get(`/api/heartbeat-runs/${fixture.maintenanceRunId}`);
    expect(maintenance.status).toBe(200);
    expect(maintenance.body.resultJson.summary).toBe("Maintenance complete");
  });

  it("returns full private-run content to the owner and an explicitly granted agent", async () => {
    const fixture = await seedFixture();

    for (const agentId of [fixture.ownerAgentId, fixture.grantedAgentId]) {
      const app = createApp(fixture.companyId, agentId);
      const detail = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ issueId: fixture.issueId });
      expect(detail.body.resultJson.summary).toBe("Read the confidential email");

      const events = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/events`);
      expect(events.status).toBe(200);
      expect(events.body[0].message).toBe("private@example.test");

      const linkedIssues = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/issues`);
      expect(linkedIssues.status).toBe(200);
      expect(linkedIssues.body[0]).toMatchObject({ issueId: fixture.issueId, title: "Confidential email triage" });
    }
  });

  it("returns no linked issue metadata to a non-member", async () => {
    const fixture = await seedFixture();
    const response = await request(createApp(fixture.companyId, fixture.otherAgentId))
      .get(`/api/heartbeat-runs/${fixture.privateRunId}/issues`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("conceals private runs from unauthorized cancellation and watchdog mutations", async () => {
    const fixture = await seedFixture();

    const deniedCancel = await request(createBoardApp(fixture.companyId, fixture.otherUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`);
    expect(deniedCancel.status).toBe(404);

    const deniedWatchdog = await request(createApp(fixture.companyId, fixture.otherAgentId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/watchdog-decisions`)
      .send({ decision: "continue" });
    expect(deniedWatchdog.status).toBe(404);

    const allowedWatchdog = await request(createBoardApp(fixture.companyId, fixture.ownerUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/watchdog-decisions`)
      .send({ decision: "continue" });
    expect(allowedWatchdog.status).toBe(200);

    await db.update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, fixture.privateRunId));
    const allowedCancel = await request(createBoardApp(fixture.companyId, fixture.ownerUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`);
    expect(allowedCancel.status).toBe(200);
    expect(allowedCancel.body.id).toBe(fixture.privateRunId);
  });

  it("keeps deleted-issue runs and operation history bound to a fail-closed tombstone", async () => {
    const fixture = await seedFixture();

    await db.delete(issues).where(eq(issues.id, fixture.issueId));

    const missingDetail = await request(createApp(fixture.companyId, fixture.ownerAgentId))
      .get(`/api/heartbeat-runs/${fixture.privateRunId}`);
    expect(missingDetail.status).toBe(404);

    const [tombstonedRun] = await db.select({
      scopeKind: heartbeatRuns.scopeKind,
      issueId: heartbeatRuns.issueId,
    })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.privateRunId));
    expect(tombstonedRun).toEqual({ scopeKind: "issue", issueId: null });

    const [operation] = await db.select({
      heartbeatRunId: workspaceOperations.heartbeatRunId,
      issueId: workspaceOperations.issueId,
    })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, fixture.operationId));
    expect(operation).toEqual({ heartbeatRunId: fixture.privateRunId, issueId: null });

    const missingOperationLog = await request(createApp(fixture.companyId, fixture.ownerAgentId))
      .get(`/api/workspace-operations/${fixture.operationId}/log`);
    expect(missingOperationLog.status).toBe(404);
  });

  it("logs would-deny decisions without enforcing them in shadow mode", async () => {
    const fixture = await seedFixture();
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "shadow";
    try {
      const response = await request(createApp(fixture.companyId, fixture.otherAgentId))
        .get(`/api/heartbeat-runs/${fixture.privateRunId}`);
      expect(response.status).toBe(200);
      expect(response.body.resultJson.summary).toBe("Read the confidential email");
    } finally {
      process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    }
  });
});
