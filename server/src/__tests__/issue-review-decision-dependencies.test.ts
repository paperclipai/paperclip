import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping review decision route tests: ${support.reason}`);

type Db = ReturnType<typeof createDb>;

describePostgres("review decisions with unresolved dependencies", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-decisions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // Each fixture owns a company; retain rows until database teardown so async
  // wake/audit publications cannot race per-test deletes.
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(status: "in_review" | "in_progress", hasBlocker = true) {
    const [company] = await db.insert(companies).values({
      name: `Review decisions ${randomUUID()}`,
      issuePrefix: `RD${randomUUID().slice(0, 8).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [reviewer, builder] = await db.insert(agents).values(
      ["Reviewer", "Builder"].map((name) => ({
        companyId: company.id, name, role: "engineer", adapterType: "process",
        adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      })),
    ).returning();
    const [issue, blocker] = await db.insert(issues).values([
      { companyId: company.id, title: "Reviewed change", status,
        assigneeAgentId: reviewer.id, responsibleUserId: "board-user" },
      { companyId: company.id, title: "Open prerequisite", status: "todo",
        responsibleUserId: "board-user" },
    ]).returning();
    if (hasBlocker) await db.insert(issueRelations).values({
      companyId: company.id, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks",
    });
    const stageId = randomUUID();
    const participant = { type: "agent" as const, agentId: reviewer.id, userId: null };
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: reviewer.id, status: "running",
      contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({
      checkoutRunId: run.id, executionRunId: run.id,
      executionPolicy: normalizeIssueExecutionPolicy({
        stages: [{ id: stageId, type: "review", participants: [participant] }],
      }),
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: participant,
        returnAssignee: { type: "agent", agentId: builder.id, userId: null },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: reviewer.id, companyId: company.id,
        runId: run.id, source: "agent_jwt" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, issue, blocker, reviewer, builder, run };
  }

  async function waitForWake(agentId: string, reason: string) {
    await expect.poll(async () => {
      const wakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      return wakes.some((wake) => wake.status === "skipped" && wake.reason === reason);
    }).toBe(true);
  }

  it.each(["in_review", "in_progress"] as const)(
    "records final approval from %s while holding completion",
    async (status) => {
      const f = await fixture(status);
      const res = await request(f.app).patch(`/api/issues/${f.issue.id}`)
        .send({ status: "done", comment: "Approved after independent review" });
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
      expect(res.body.status).toBe(status);
      expect(res.body.executionState).toMatchObject({
        status: "completed", lastDecisionOutcome: "approved",
        dependencyHold: { unresolvedBlockerIssueIds: [f.blocker.id] },
      });
      const decisions = await db.select().from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, f.issue.id));
      expect(decisions).toMatchObject([{ outcome: "approved", actorAgentId: f.reviewer.id }]);
      const [stored] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(stored.status).toBe(status);
      expect(stored.completedAt).toBeNull();
    },
  );

  it.each([false, true])("records changes requested with open blocker=%s", async (hasBlocker) => {
    const f = await fixture("in_review", hasBlocker);
    if (hasBlocker) await db.update(agents).set({
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    }).where(eq(agents.id, f.builder.id));
    const res = await request(f.app).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "in_progress", comment: "Changes requested: correctness defect" });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
    expect(res.body.status).toBe("in_progress");
    expect(res.body.executionState).toMatchObject({ status: "changes_requested", lastDecisionOutcome: "changes_requested" });
    expect(res.body.assigneeAgentId).toBe(f.builder.id);
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, f.issue.id));
    expect(decisions).toMatchObject([{ outcome: "changes_requested", actorAgentId: f.reviewer.id }]);
    await waitForWake(f.builder.id, hasBlocker
      ? "issue_dependencies_blocked" : "heartbeat.wakeOnDemand.disabled");
    const builderRuns = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.builder.id));
    expect(builderRuns).toEqual([]);
  });

  it("still rejects ordinary work admission, even with a client-supplied decision option", async () => {
    const f = await fixture("in_progress");
    await db.update(issues).set({ executionState: null, executionPolicy: null })
      .where(eq(issues.id, f.issue.id));
    const res = await request(f.app).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "in_progress", recordExecutionDecision: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Issue is blocked by unresolved blockers");
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, f.issue.id));
    expect(decisions).toEqual([]);
  });

  it("does not record a decision from an agent outside the stage", async () => {
    const f = await fixture("in_review");
    const [stored] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    await db.update(issues).set({
      executionPolicy: normalizeIssueExecutionPolicy({ stages: [{
        id: stored.executionState!.currentStageId!, type: "review",
        participants: [{ type: "agent", agentId: f.builder.id, userId: null }],
      }] }),
      executionState: {
      ...stored.executionState!,
      currentParticipant: { type: "agent", agentId: f.builder.id, userId: null },
    } }).where(eq(issues.id, f.issue.id));
    const res = await request(f.app).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "in_progress", comment: "Unauthorized changes requested" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, f.issue.id));
    expect(decisions).toEqual([]);
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(unchanged.status).toBe("in_review");
    await waitForWake(f.builder.id, "heartbeat.wakeOnDemand.disabled");
  });
});
