import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue auto-assign route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create auto-assign (INUA-7276)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-auto-assign-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creating agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  it("defaults assigneeAgentId to the requesting agent when omitted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parent = await seedParent(companyId);
    const app = createApp(agentActor(companyId, agentId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Task without explicit assignee" })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(agentId);
  });

  it("defaults assigneeAgentId to the requesting agent when null is passed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parent = await seedParent(companyId);
    const app = createApp(agentActor(companyId, agentId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Task with null assignee", assigneeAgentId: null })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(agentId);
  });

  it("honours an explicit assigneeAgentId when provided", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parent = await seedParent(companyId);
    // Seed a second agent to assign to
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other agent",
      role: "pm",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = createApp(agentActor(companyId, agentId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Task assigned to other", assigneeAgentId: otherAgentId })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(otherAgentId);
  });

  it("does not apply a default when the actor is a board user", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const parent = await seedParent(companyId);
    const app = createApp(boardActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Task from board with no assignee" })
      .expect(201);

    expect(res.body.assigneeAgentId).toBeNull();
  });
});
