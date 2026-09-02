import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
    `Skipping run-lock comment guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue run-lock comment guard (LUX-1797)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-lock-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Use TRUNCATE CASCADE to avoid FK ordering issues with the many tables
    // touched by the issue PATCH route (issue_inbox_archives, agent_wakeup_requests, etc.)
    await db.execute(sql`TRUNCATE TABLE 
      issue_inbox_archives, issue_comments, issue_relations, activity_log, issues,
      heartbeat_runs, agent_wakeup_requests, agents, companies
      CASCADE`);
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

  async function seedCompanyAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const lockedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: lockedRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockedRunId,
      executionAgentNameKey: "testagent",
      executionLockedAt: new Date(),
    });

    return { companyId, agentId, issueId, lockedRunId };
  }

  function boardActorNoRunId(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function boardActorWithRunId(companyId: string, runId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
      runId,
    } as Express.Request["actor"];
  }

  it("allows a comment+done PATCH with no run id to close a run-locked issue (null run id falls through)", async () => {
    const { companyId, issueId, lockedRunId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(boardActorNoRunId(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Hourly health check + git pull completed.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    // A null run id (no X-Paperclip-Run-Id header) must fall through unchanged.
    // The guard fires only when actor.runId is present AND differs.
    expect(row?.status).toBe("done");

    // Comment should still be persisted.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toBe("Hourly health check + git pull completed.");
  });

  it("strips status when a board actor with a DIFFERENT run id PATCHes a comment+done on a run-locked issue", async () => {
    const { companyId, agentId, issueId, lockedRunId } = await seedCompanyAgentAndIssue();
    const otherRunId = randomUUID();

    // The other run must exist in heartbeat_runs for the route to accept it.
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    const res = await request(createApp(boardActorWithRunId(companyId, otherRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Routine completion from a different run.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    // Status should NOT have changed to done — stripped by the guard because
    // the actor's run id differs from the issue's executionRunId.
    expect(row?.status).toBe("in_progress");
    expect(row?.executionRunId).toBe(lockedRunId);

    // But the comment should have been persisted.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toBe("Routine completion from a different run.");
  });

  it("allows a plain board close (no comment) of a run-locked issue", async () => {
    const { companyId, issueId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(boardActorNoRunId(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    // Board close with no comment should still work.
    expect(row?.status).toBe("done");
  });

  it("allows a board actor with the matching run id to close a locked issue with a comment", async () => {
    const { companyId, issueId, lockedRunId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(boardActorWithRunId(companyId, lockedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Done by the owning run.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    // The owning run should be able to close its own issue.
    expect(row?.status).toBe("done");
  });

  it("does not strip status when the issue has no executionRunId", async () => {
    const { companyId, issueId, lockedRunId } = await seedCompanyAgentAndIssue();

    // Clear the execution lock so the guard should not fire.
    await db.update(issues)
      .set({ executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActorNoRunId(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Closing now that the lock is cleared.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    expect(row?.status).toBe("done");
  });
});