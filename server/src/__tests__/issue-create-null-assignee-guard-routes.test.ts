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
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres null-assignee guard route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * ALAA-2113 (regression of ALAA-766). ALAA-766 was closed on intent, not on
 * evidence: it shipped without a test, silently stopped taking effect, and 32
 * dormant issues accumulated before a drift scan found them.
 *
 * A null-assignee issue is invisible work -- nothing wakes an agent for it.
 * These tests pin the guard on every agent-reachable create path. The original
 * ALAA-2113 plan named only the top-level route; the child paths carry the same
 * hole, and the one live drift instance on the board came through a child path.
 */
describeEmbeddedPostgres("agent issue create null-assignee guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-null-assignee-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Null Assignee Agent") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent!;
  }

  function asAgent(agent: { id: string; adapterType: string }, companyId: string) {
    const runId = randomUUID();
    const token = createLocalAgentJwt(agent.id, companyId, agent.adapterType, runId);
    return { token, runId };
  }

  it("defaults the assignee to the creating agent on top-level create", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const { token, runId } = asAgent(agent, companyId);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "Agent create with no assignee" })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(agent.id);
    expect(res.headers["x-paperclip-issue-autoassigned"]).toBe("creator");
  });

  it("defaults the assignee to the creating agent on child create", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const parent = await seedParent(companyId);
    const { token, runId } = asAgent(agent, companyId);

    const res = await request(createApp())
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "Child create with no assignee" })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(agent.id);
    expect(res.headers["x-paperclip-issue-autoassigned"]).toBe("creator");
  });

  it("leaves an explicit agent assignee untouched", async () => {
    const companyId = await seedCompany();
    const creator = await seedAgent(companyId, "Creator");
    const delegate = await seedAgent(companyId, "Delegate");
    const { token, runId } = asAgent(creator, companyId);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "Explicit delegation", assigneeAgentId: delegate.id })
      .expect(201);

    expect(res.body.assigneeAgentId).toBe(delegate.id);
    expect(res.headers["x-paperclip-issue-autoassigned"]).toBeUndefined();
  });

  it("leaves board-authored creates unassigned so human triage still works", async () => {
    const companyId = await seedCompany();

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Human triage item" })
      .expect(201);

    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.assigneeUserId ?? null).toBeNull();
    expect(res.headers["x-paperclip-issue-autoassigned"]).toBeUndefined();
  });
});
