import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("issue execution policy PostgreSQL routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-decision-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(companyId: string, userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("persists one decision through the HTTP route and rolls back blocker mutation attempts", async () => {
    const companyId = randomUUID();
    const reviewerUserId = `reviewer-${randomUUID()}`;
    const returnUserId = `return-${randomUUID()}`;
    const blockerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Execution policy route test",
      issuePrefix: `ER${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      {
        id: reviewerUserId,
        name: "Reviewer",
        email: `${reviewerUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: returnUserId,
        name: "Return assignee",
        email: `${returnUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: reviewerUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: returnUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: issueId,
        companyId,
        title: "Issue under user review",
        status: "in_review",
        priority: "high",
        assigneeUserId: reviewerUserId,
        executionPolicy: {
          stages: [{
            id: stageId,
            type: "review",
            participants: [{ type: "user", userId: reviewerUserId }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "user", userId: reviewerUserId },
          returnAssignee: { type: "user", userId: returnUserId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      },
    ]);
    const svc = issueService(db);
    await svc.update(issueId, { blockedByIssueIds: [blockerId] });
    const app = appFor(companyId, reviewerUserId);

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_progress",
        blockedByIssueIds: [],
        comment: "This must roll back instead of removing the blocker.",
      })
      .expect(422);
    await expect(db.select().from(issueExecutionDecisions)).resolves.toEqual([]);
    await expect(svc.getRelationSummaries(issueId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: blockerId, status: "todo" })],
    });

    const response = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Please revise this work." })
      .expect(200);

    expect(response.body).toMatchObject({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: returnUserId,
      executionState: {
        status: "changes_requested",
        lastDecisionOutcome: "changes_requested",
      },
    });
    const decisionId = response.body.executionState.lastDecisionId as string;
    expect(decisionId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(db.query.issueExecutionDecisions.findFirst({
      where: eq(issueExecutionDecisions.id, decisionId),
    })).resolves.toMatchObject({
      issueId,
      stageId,
      actorAgentId: null,
      actorUserId: reviewerUserId,
      outcome: "changes_requested",
      body: "Please revise this work.",
      createdByRunId: null,
    });
    await expect(db.select().from(issueExecutionDecisions)).resolves.toHaveLength(1);
    await expect(svc.getRelationSummaries(issueId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: blockerId, status: "todo" })],
    });
  }, 20_000);
});
