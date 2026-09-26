import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
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
    `Skipping embedded Postgres same-agent live sibling checkout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("same-agent live sibling checkout lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-same-agent-live-sibling-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
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

  async function seedCompanyAgentsAndRuns() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const siblingRunId = randomUUID();
    const actorRunId = randomUUID();
    const otherAgentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    // The holder is a LIVE run of the SAME agent; the actor is a second live run
    // of that same agent. The other agent's run is also live so the negative case
    // cannot pass merely because the run is missing.
    await db.insert(heartbeatRuns).values([
      {
        id: siblingRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: otherAgentRunId,
        companyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return {
      companyId,
      assigneeAgentId,
      otherAgentId,
      siblingRunId,
      actorRunId,
      otherAgentRunId,
    };
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function seedIssue(input: {
    companyId: string;
    assigneeAgentId: string;
    checkoutRunId: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Sibling-held issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.checkoutRunId,
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  // TES-114 / TES-116: the assignee must be able to write its own issue even
  // when a concurrently live run of the SAME agent holds the checkout.
  it("lets a live sibling run of the same assignee agent PATCH the issue", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Written by sibling run" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Written by sibling run");

    const row = await db
      .select({ title: issues.title, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Written by sibling run");
    expect(row?.checkoutRunId).toBe(seed.actorRunId);
  });

  it("lets the same assignee agent comment on an issue held by a live sibling run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Sibling run comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("still refuses a live checkout held by a DIFFERENT agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.otherAgentRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
  });
});
