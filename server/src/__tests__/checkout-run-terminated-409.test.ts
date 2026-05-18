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
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping checkout-run-terminated-409 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /api/issues/:id/checkout — terminated run guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-run-terminated-");
    db = createDb(tempDb.connectionString);
  }, 20000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
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

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent-jwt",
    } as Express.Request["actor"];
  }

  async function seedCompanyAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex/local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "manual",
      finishedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue for checkout guard",
      status: "todo",
      assignedAgentId: agentId,
    });

    return { companyId, agentId, issueId, failedRunId };
  }

  it("returns 409 with checkout_run_terminated when run is in 'failed' state", async () => {
    const { companyId, agentId, issueId, failedRunId } = await seedCompanyAgentAndIssue();
    const app = createApp(agentActor(companyId, agentId, failedRunId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .set("x-agent-run-id", failedRunId)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "checkout_run_terminated" });

    const [row] = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row.status).toBe("todo");
    expect(row.executionRunId).toBeNull();
  });

  it("returns 409 when checkoutRunId points to a non-existent run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    const ghostRunId = randomUUID();
    const app = createApp(agentActor(companyId, agentId, ghostRunId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .set("x-agent-run-id", ghostRunId)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "checkout_run_terminated" });
  });

  it("succeeds normally when run is active ('running')", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentAndIssue();
    const runningRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    const app = createApp(agentActor(companyId, agentId, runningRunId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .set("x-agent-run-id", runningRunId)
      .send({ agentId, expectedStatuses: ["todo"] });

    expect(res.status).not.toBe(409);
    expect(res.status).toBeLessThan(500);
  });
});
