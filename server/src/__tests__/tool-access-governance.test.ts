import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
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
    `Skipping embedded Postgres tool access governance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("tool access governance", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("tool-access-governance");
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

  async function seedCompanyAgentAndTool() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const [company] = await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    const [agent] = await db.insert(agents).values({
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
    }).returning();
    const [tool] = await db.insert(companyTools).values({
      companyId,
      key: "mcp.gbrain.query",
      label: "GBrain query",
      source: "mcp_tool",
      adapter: "hermes_local",
      serverKey: "gbrain",
      toolName: "query",
      risk: "read",
      supportedModes: ["off", "read"],
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
    }).returning();
    return { company, agent, tool };
  }

  it("logs per-grant audit events with before and after modes", async () => {
    const app = createApp();
    const { company, agent, tool } = await seedCompanyAgentAndTool();

    await request(app)
      .post(`/api/companies/${company.id}/tool-grants`)
      .send({ grants: [{ agentId: agent.id, toolId: tool.id, mode: "read" }] })
      .expect(200);

    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    const grantEvent = activity.find((event) => event.action === "company.tool_grant_changed");

    expect(grantEvent).toBeTruthy();
    expect(grantEvent?.entityId).toBe(tool.id);
    expect(grantEvent?.details).toMatchObject({
      agentId: agent.id,
      toolLabel: "GBrain query",
      previousMode: "off",
      newMode: "read",
      risk: "read",
    });
  });
});
