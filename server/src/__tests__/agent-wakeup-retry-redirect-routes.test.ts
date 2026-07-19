import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Retry redirect test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wakeup retry-redirect route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId: null,
    source: "agent_jwt",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("agent wakeup retry_failed_run redirect routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-retry-redirect-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Let any background run execution drain before the next test / teardown.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    runningProcesses.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts: {
    assigneeAgent?: "original" | "other" | "terminated" | null;
    assigneeUserId?: string | null;
  } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    async function seedAgent(name: string, status: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: {},
      });
      return id;
    }

    const originalAgentId = await seedAgent("Original Owner", "active");
    const otherAgentId = await seedAgent("New Owner", "active");
    const terminatedAgentId = await seedAgent("Terminated Owner", "terminated");

    const assigneeAgent = opts.assigneeAgent === undefined ? "other" : opts.assigneeAgent;
    const assigneeAgentId =
      assigneeAgent === "original"
        ? originalAgentId
        : assigneeAgent === "other"
          ? otherAgentId
          : assigneeAgent === "terminated"
            ? terminatedAgentId
            : null;

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId,
      assigneeUserId: opts.assigneeUserId ?? null,
    });

    return { companyId, originalAgentId, otherAgentId, terminatedAgentId, issueId };
  }

  async function runsForAgent(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  it("redirects a retry_failed_run wake to the issue's current assignee agent", async () => {
    const fixture = await seedFixture({ assigneeAgent: "other" });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeDefined();
    expect(res.body.agentId).toBe(fixture.otherAgentId);

    expect(await runsForAgent(fixture.originalAgentId)).toHaveLength(0);
    expect(await runsForAgent(fixture.otherAgentId)).toHaveLength(1);

    const logRows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.runId, res.body.id));
    const invoked = logRows.find((row) => row.action === "heartbeat.invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.details).toMatchObject({
      agentId: fixture.otherAgentId,
      redirectedFromAgentId: fixture.originalAgentId,
      issueId: fixture.issueId,
    });
  });

  it("skips with an honest message when the issue is now assigned to a user", async () => {
    const fixture = await seedFixture({ assigneeAgent: null, assigneeUserId: "user-1" });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeUndefined();
    expect(res.body.status).toBe("skipped");
    expect(res.body.message).toMatch(/assigned to a user/i);

    expect(await runsForAgent(fixture.originalAgentId)).toHaveLength(0);
    expect(await runsForAgent(fixture.otherAgentId)).toHaveLength(0);
  });

  it("skips with an honest message when the issue is now unassigned", async () => {
    const fixture = await seedFixture({ assigneeAgent: null });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeUndefined();
    expect(res.body.status).toBe("skipped");
    expect(res.body.message).toMatch(/unassigned/i);

    expect(await runsForAgent(fixture.originalAgentId)).toHaveLength(0);
  });

  it("skips instead of redirecting when the current assignee agent is terminated", async () => {
    const fixture = await seedFixture({ assigneeAgent: "terminated" });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeUndefined();
    expect(res.body.status).toBe("skipped");
    expect(res.body.message).toContain("Terminated Owner");

    expect(await runsForAgent(fixture.originalAgentId)).toHaveLength(0);
    expect(await runsForAgent(fixture.terminatedAgentId)).toHaveLength(0);
  });

  it("wakes the addressed agent unchanged when the retry payload has no issueId", async () => {
    const fixture = await seedFixture({ assigneeAgent: "other" });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeDefined();
    expect(res.body.agentId).toBe(fixture.originalAgentId);
  });

  it("wakes the addressed agent unchanged for reasons other than retry_failed_run", async () => {
    const fixture = await seedFixture({ assigneeAgent: "other" });
    const app = createApp(db, boardActor(fixture.companyId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "resume_process_lost_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeDefined();
    expect(res.body.agentId).toBe(fixture.originalAgentId);
  });

  it("keeps agent self-invocation behavior unchanged for retry_failed_run", async () => {
    const fixture = await seedFixture({ assigneeAgent: "other" });
    const app = createApp(db, agentActor(fixture.companyId, fixture.originalAgentId));

    const res = await request(app)
      .post(`/api/agents/${fixture.originalAgentId}/wakeup`)
      .send({
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: { issueId: fixture.issueId },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toBeDefined();
    expect(res.body.agentId).toBe(fixture.originalAgentId);
  });
});
