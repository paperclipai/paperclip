import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("cancellation attribution in run lifecycle events", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const info = vi.spyOn(logger, "info");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-cancellation-attribution-");
    db = createDb(database.connectionString);
    await import("../routes/agents.js");
  }, 60_000);

  afterEach(() => {
    info.mockClear();
  });

  afterAll(async () => {
    info.mockRestore();
    await database?.cleanup();
  });

  async function seedRunningRun() {
    const [company] = await db.insert(companies).values({
      name: "Cancellation",
      issuePrefix: `C${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Cancelled agent",
      role: "engineer",
      status: "running",
      adapterType: "process",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
    }).returning();
    return { companyId: company!.id, agentId: agent!.id, runId: run!.id };
  }

  function cancellationEvent(runId: string) {
    return info.mock.calls
      .map(([fields]) => (fields as { lifecycleEvent?: { runId?: string; toStatus?: string; cancellation?: unknown } }).lifecycleEvent)
      .find((event) => event?.runId === runId && event.toStatus === "cancelled");
  }

  it("names the board user who stopped the run", async () => {
    const { companyId, runId } = await seedRunningRun();
    const { agentRoutes } = await import("../routes/agents.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db));

    const res = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(cancellationEvent(runId)?.cancellation).toEqual({
      code: "cancelled",
      reason: "Cancelled by a board operator",
      requestedBy: { type: "user", id: "board-user" },
    });
  });

  it("gives the cause and no requester when the system cancels the run", async () => {
    const { agentId, runId } = await seedRunningRun();

    await heartbeatService(db).cancelActiveForAgent(agentId, "Cancelled due to agent pause");

    expect(cancellationEvent(runId)?.cancellation).toEqual({
      code: "agent_paused",
      reason: "Cancelled due to agent pause",
      requestedBy: null,
    });
  });
});
