import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { eq, inArray } from "drizzle-orm";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance agent pause tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

let routeImportSeq = 0;

async function createRouteApp(db: ReturnType<typeof createDb>, actor: Record<string, unknown>) {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/agents.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  routeImportSeq += 1;
  const routeModulePath = `../routes/agents.ts?instance-agent-pause-routes-${routeImportSeq}`;
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/agents.ts")>,
    import("../middleware/index.ts"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

async function insertCompany(
  db: ReturnType<typeof createDb>,
  input: { name: string; status?: string },
) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: input.name,
    issuePrefix: issuePrefix(companyId),
    status: input.status ?? "active",
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

async function insertAgent(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    name: string;
    status?: string;
    pauseReason?: string | null;
    pausedAt?: Date | null;
  },
) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId: input.companyId,
    name: input.name,
    role: "engineer",
    status: input.status ?? "idle",
    pauseReason: input.pauseReason ?? null,
    pausedAt: input.pausedAt ?? null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return agentId;
}

async function insertRun(
  db: ReturnType<typeof createDb>,
  input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running";
  },
) {
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId: input.companyId,
    agentId: input.agentId,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: input.status,
    startedAt: input.status === "running" ? new Date("2026-04-20T12:00:00.000Z") : null,
  });
  return runId;
}

describeEmbeddedPostgres("instance agent pause routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-agent-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pauses runnable agents across non-archived companies and cancels their active runs", async () => {
    const firstCompanyId = await insertCompany(db, { name: "First" });
    const secondCompanyId = await insertCompany(db, { name: "Second" });
    const archivedCompanyId = await insertCompany(db, { name: "Archived", status: "archived" });
    const idleAgentId = await insertAgent(db, { companyId: firstCompanyId, name: "Idle", status: "idle" });
    const runningAgentId = await insertAgent(db, { companyId: firstCompanyId, name: "Running", status: "running" });
    const manualPausedId = await insertAgent(db, {
      companyId: firstCompanyId,
      name: "Manual",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const budgetPausedId = await insertAgent(db, {
      companyId: firstCompanyId,
      name: "Budget",
      status: "paused",
      pauseReason: "budget",
      pausedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const pendingId = await insertAgent(db, { companyId: firstCompanyId, name: "Pending", status: "pending_approval" });
    const terminatedId = await insertAgent(db, { companyId: firstCompanyId, name: "Terminated", status: "terminated" });
    const errorAgentId = await insertAgent(db, { companyId: secondCompanyId, name: "Error", status: "error" });
    const archivedAgentId = await insertAgent(db, { companyId: archivedCompanyId, name: "Archived Agent", status: "idle" });
    const queuedRunId = await insertRun(db, { companyId: firstCompanyId, agentId: idleAgentId, status: "queued" });
    const runningRunId = await insertRun(db, { companyId: firstCompanyId, agentId: runningAgentId, status: "running" });
    const preservedRunId = await insertRun(db, { companyId: firstCompanyId, agentId: manualPausedId, status: "queued" });

    const app = await createRouteApp(db, {
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app).post("/api/instance/agents/pause-all").send({});

    expect(res.status).toBe(200);
    expect(res.body.pausedAgents).toBe(3);
    expect(res.body.cancelledRuns).toBe(2);
    expect(res.body.affectedCompanyIds.sort()).toEqual([firstCompanyId, secondCompanyId].sort());
    expect(res.body.counts.tokenPausedAgents).toBe(3);
    expect(res.body.counts.manualPausedAgents).toBe(1);
    expect(res.body.counts.budgetPausedAgents).toBe(1);
    expect(res.body.counts.pendingApprovalAgents).toBe(1);
    expect(res.body.counts.terminatedAgents).toBe(1);

    const agentRows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(inArray(agents.id, [
        idleAgentId,
        runningAgentId,
        manualPausedId,
        budgetPausedId,
        pendingId,
        terminatedId,
        errorAgentId,
        archivedAgentId,
      ]));
    const byId = new Map(agentRows.map((row) => [row.id, row]));
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "token_availability" });
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "token_availability" });
    expect(byId.get(errorAgentId)).toMatchObject({ status: "paused", pauseReason: "token_availability" });
    expect(byId.get(manualPausedId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(budgetPausedId)).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(byId.get(pendingId)).toMatchObject({ status: "pending_approval", pauseReason: null });
    expect(byId.get(terminatedId)).toMatchObject({ status: "terminated", pauseReason: null });
    expect(byId.get(archivedAgentId)).toMatchObject({ status: "idle", pauseReason: null });

    const runRows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [queuedRunId, runningRunId, preservedRunId]));
    const runsById = new Map(runRows.map((row) => [row.id, row.status]));
    expect(runsById.get(queuedRunId)).toBe("cancelled");
    expect(runsById.get(runningRunId)).toBe("cancelled");
    expect(runsById.get(preservedRunId)).toBe("queued");

    const activities = await db.select().from(activityLog);
    expect(activities).toHaveLength(2);
    expect(activities.map((entry) => entry.action)).toEqual([
      "agents.token_pause_applied",
      "agents.token_pause_applied",
    ]);
  });

  it("resumes only agents paused by the token switch", async () => {
    const companyId = await insertCompany(db, { name: "Paperclip" });
    const tokenPausedId = await insertAgent(db, {
      companyId,
      name: "Token Paused",
      status: "paused",
      pauseReason: "token_availability",
      pausedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const manualPausedId = await insertAgent(db, {
      companyId,
      name: "Manual Paused",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const budgetPausedId = await insertAgent(db, {
      companyId,
      name: "Budget Paused",
      status: "paused",
      pauseReason: "budget",
      pausedAt: new Date("2026-04-20T10:00:00.000Z"),
    });

    const app = await createRouteApp(db, {
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app).post("/api/instance/agents/resume-token-paused").send({});

    expect(res.status).toBe(200);
    expect(res.body.resumedAgents).toBe(1);
    expect(res.body.affectedCompanyIds).toEqual([companyId]);
    expect(res.body.counts.tokenPausedAgents).toBe(0);
    expect(res.body.counts.manualPausedAgents).toBe(1);
    expect(res.body.counts.budgetPausedAgents).toBe(1);

    const agentRows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents)
      .where(inArray(agents.id, [tokenPausedId, manualPausedId, budgetPausedId]));
    const byId = new Map(agentRows.map((row) => [row.id, row]));
    expect(byId.get(tokenPausedId)).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });
    expect(byId.get(manualPausedId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(budgetPausedId)).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("requires instance admin access before mutating agents", async () => {
    const companyId = await insertCompany(db, { name: "Paperclip" });
    const agentId = await insertAgent(db, { companyId, name: "Builder", status: "idle" });
    const app = await createRouteApp(db, {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).post("/api/instance/agents/pause-all").send({});

    expect(res.status).toBe(403);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ status: "idle", pauseReason: null });
  });
});
