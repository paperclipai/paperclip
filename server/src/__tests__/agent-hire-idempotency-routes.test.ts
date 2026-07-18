import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentHireOperations,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent hire idempotency routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  const previousBudget = process.env.PAPERCLIP_AGENT_HIRE_REQUEST_BUDGET_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-idempotency-routes-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    process.env.PAPERCLIP_AGENT_HIRE_REQUEST_BUDGET_MS = "0";
  }, 20_000);

  afterAll(async () => {
    if (previousBudget === undefined) delete process.env.PAPERCLIP_AGENT_HIRE_REQUEST_BUDGET_MS;
    else process.env.PAPERCLIP_AGENT_HIRE_REQUEST_BUDGET_MS = previousBudget;
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("returns a queryable 202, creates one agent concurrently, and replays the result", async () => {
    const app = createApp();
    const key = "route-concurrent-hire";
    const payload = {
      name: "Durable Builder",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    };

    const responses = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/agent-hires`)
        .set("Idempotency-Key", key)
        .send(payload),
      request(app)
        .post(`/api/companies/${companyId}/agent-hires`)
        .set("Idempotency-Key", key)
        .send(payload),
    ]);
    expect(responses.every((response) => response.status === 201 || response.status === 202)).toBe(true);

    const [operation] = await db.select().from(agentHireOperations);
    expect(operation).toBeDefined();
    let statusResponse = await request(app)
      .get(`/api/companies/${companyId}/agent-hire-operations/${operation!.id}`)
      .expect(200);
    for (let attempt = 0; statusResponse.body.status === "pending" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      statusResponse = await request(app)
        .get(`/api/companies/${companyId}/agent-hire-operations/${operation!.id}`)
        .expect(200);
    }
    expect(statusResponse.body.status).toBe("succeeded");
    expect(statusResponse.body.stageTimings).toEqual(expect.objectContaining({
      desired_skill_resolution: expect.any(Number),
      config_normalization: expect.any(Number),
      agent_creation: expect.any(Number),
      instruction_materialization: expect.any(Number),
      approval_linking: expect.any(Number),
      grants: expect.any(Number),
      activity_logging: expect.any(Number),
    }));

    const replay = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .set("Idempotency-Key", key)
      .send(payload)
      .expect(201);
    expect(replay.headers["idempotency-key-replay"]).toBe("true");
    expect(replay.body.agent.id).toBe(operation!.agentId);
    expect(await db.select().from(agents)).toHaveLength(1);

    const mismatch = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .set("Idempotency-Key", key)
      .send({ ...payload, name: "Different Builder" })
      .expect(422);
    expect(mismatch.body.details?.code).toBe("idempotency_key_payload_mismatch");
  }, 20_000);
});
