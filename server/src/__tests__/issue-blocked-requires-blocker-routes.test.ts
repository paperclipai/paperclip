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
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ALAA-965 PATCH-guard route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// ALAA-965: PATCH /api/issues/:id must reject agent writes that would leave
// the issue in `status=blocked` with an empty blockedBy[] set. Board writes
// retain the previous behavior because the board is the authoritative human
// override path.
describeEmbeddedPostgres("ALAA-965 PATCH guard: blocked_requires_blocker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-alaa965-patch-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seedCompanyAgentAndIssue(input: {
    issueStatus?: "todo" | "in_progress" | "blocked";
    seedBlockerIssue?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "ALAA965 Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "ALAA-965 subject issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    if (input.seedBlockerIssue) {
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        title: "Live blocker",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
      });
      await db.insert(issueRelations).values({
        id: randomUUID(),
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    return { companyId, agentId, runId, issueId, blockerIssueId };
  }

  it("rejects an agent PATCH that sets status=blocked with no blockers", async () => {
    const { companyId, agentId, runId, issueId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ error: "blocked_requires_blocker" });

    const [row] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row?.status).toBe("in_progress");
  });

  it("rejects an agent PATCH that sets status=blocked with blockedByIssueIds=[]", async () => {
    const { companyId, agentId, runId, issueId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ error: "blocked_requires_blocker" });
  });

  it("accepts an agent PATCH that sets status=blocked with a named blocker", async () => {
    const { companyId, agentId, runId, issueId, blockerIssueId } =
      await seedCompanyAgentAndIssue({ seedBlockerIssue: true });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [blockerIssueId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row?.status).toBe("blocked");
  });

  it("accepts an agent PATCH that omits status but updates blockedByIssueIds while the issue is already blocked-with-blocker", async () => {
    const { companyId, agentId, runId, issueId, blockerIssueId } =
      await seedCompanyAgentAndIssue({ issueStatus: "blocked", seedBlockerIssue: true });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ blockedByIssueIds: [blockerIssueId], title: "still blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("still blocked");
  });

  it("rejects an agent PATCH that clears blockers while leaving status=blocked", async () => {
    const { companyId, agentId, runId, issueId } =
      await seedCompanyAgentAndIssue({ issueStatus: "blocked", seedBlockerIssue: true });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ blockedByIssueIds: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ error: "blocked_requires_blocker" });
  });

  it("accepts a board PATCH that sets status=blocked with no blockers", async () => {
    // ALAA-965 only restricts the agent write path. The board remains the
    // authoritative override and can park an issue in status=blocked with no
    // blockers when an operator explicitly chooses to.
    const { companyId, issueId } = await seedCompanyAgentAndIssue();

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row?.status).toBe("blocked");
  });
});
