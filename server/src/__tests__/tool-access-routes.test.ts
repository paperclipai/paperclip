import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentToolGrants, agents, companies, companyTools, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { toolAccessRoutes } from "../routes/tool-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tool access route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("tool access routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("tool-access-routes");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentToolGrants);
    await db.delete(companyTools);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", toolAccessRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GBrain Researcher",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  it("lists tools, creates catalog entries, and updates grants", async () => {
    const app = createApp();
    const { companyId, agentId } = await seedCompanyAndAgent();

    await request(app).get(`/api/companies/${companyId}/tools`).expect(200);

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/tools`)
      .send({
        key: "mcp.gbrain.query",
        label: "GBrain query",
        source: "mcp_tool",
        adapter: "hermes_local",
        serverKey: "gbrain",
        toolName: "query",
        risk: "read",
        supportedModes: ["off", "read"],
      })
      .expect(201);

    const toolId = createRes.body.id as string;

    const grantRes = await request(app)
      .post(`/api/companies/${companyId}/tool-grants`)
      .send({ grants: [{ agentId, toolId, mode: "read" }] })
      .expect(200);

    expect(grantRes.body.grants).toEqual([
      expect.objectContaining({
        agentId,
        toolId,
        mode: "read",
      }),
    ]);
  });
});
