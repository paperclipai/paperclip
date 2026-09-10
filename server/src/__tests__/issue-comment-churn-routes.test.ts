import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
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
    `Skipping embedded Postgres issue comment churn route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue comment churn routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comment-churn-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
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

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const ownerAgentId = randomUUID();
    const ownerRunIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "OwnerAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values(
      ownerRunIds.map((runId) => ({
        id: runId,
        companyId,
        agentId: ownerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      })),
    );
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comment churn route issue",
      status: "todo",
      priority: "high",
      assigneeAgentId: null,
    });

    return { companyId, issueId, ownerAgentId, ownerRunIds };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string, userId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  it("rejects the fourth rapid same-agent comment even when run ids change", async () => {
    const { companyId, issueId, ownerAgentId, ownerRunIds } = await seedIssue();

    for (let index = 0; index < 3; index += 1) {
      const res = await request(
        createApp(agentActor(companyId, ownerAgentId, ownerRunIds[index])),
      )
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: `comment ${index + 1}` });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const fourth = await request(createApp(agentActor(companyId, ownerAgentId, ownerRunIds[3])))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "comment 4" });

    expect(fourth.status, JSON.stringify(fourth.body)).toBe(409);
    expect(fourth.body.error).toContain("Issue comment churn guardrail triggered");
  });

  it("allows a different actor to comment during the same churn window", async () => {
    const { companyId, issueId, ownerAgentId, ownerRunIds } = await seedIssue();

    for (let index = 0; index < 3; index += 1) {
      const res = await request(
        createApp(agentActor(companyId, ownerAgentId, ownerRunIds[index])),
      )
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: `comment ${index + 1}` });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const peer = await request(createApp(boardActor(companyId, "board-user-2")))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "allowed from different actor" });

    expect(peer.status, JSON.stringify(peer.body)).toBe(201);
    expect(peer.body.body).toBe("allowed from different actor");
  });
});
