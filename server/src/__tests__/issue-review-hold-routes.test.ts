import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review hold route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board holds on a pending review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-hold-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedHeldReview(changesRequestedCount: number, status: "in_review" | "blocked") {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    const boardUserId = "hold-board";
    const prefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [authorAgentId, reviewerAgentId, replacementAgentId].map((id, index) => ({
        id,
        companyId,
        name: `${prefix} Agent ${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "operator",
    });
    const stageId = randomUUID();
    const issueId = randomUUID();
    const executionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: authorAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Held review",
      status,
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [
            { id: randomUUID(), type: "agent", agentId: reviewerAgentId },
            { id: randomUUID(), type: "agent", agentId: replacementAgentId },
          ],
        }],
      },
      executionState,
    });
    const board = app({
      type: "board",
      source: "session",
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    });
    return { issueId, reviewerAgentId, replacementAgentId, executionState, board };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function commentCount(issueId: string) {
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return rows.length;
  }

  async function reviewWakes(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "execution_review_requested"),
        ),
      );
  }

  async function allWakes(agentId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    return rows.filter((row) => !row.payload?.retryOfRunId);
  }

  async function settleWakes() {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  describe.each([1, 2])("with changesRequestedCount %i", (count) => {
    it("keeps the cycle through a board blocked hold and an unrelated edit, then restores the same reviewer", async () => {
      const seeded = await seedHeldReview(count, "in_review");

      const hold = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "blocked", unblockDescriptor: { owner: "board", action: "Restore the reviewer" } });
      expect(hold.status, JSON.stringify(hold.body)).toBe(200);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);

      const edit = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ priority: "high" });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.priority).toBe("high");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await reviewWakes(seeded.reviewerAgentId)).toHaveLength(0);

      const restore = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "in_review" });
      expect(restore.status, JSON.stringify(restore.body)).toBe(200);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("in_review");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toMatchObject({
        status: "pending",
        currentStageId: seeded.executionState.currentStageId,
        currentParticipant: seeded.executionState.currentParticipant,
        returnAssignee: seeded.executionState.returnAssignee,
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: count,
      });
      await vi.waitFor(async () => {
        expect(await reviewWakes(seeded.reviewerAgentId)).toHaveLength(1);
      });
      const decisions = await db
        .select()
        .from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
      expect(decisions).toHaveLength(0);
    });

    it("restores to the replacement reviewer the board assigned while blocking the review", async () => {
      const seeded = await seedHeldReview(count, "in_review");

      const hold = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({
          status: "blocked",
          assigneeAgentId: seeded.replacementAgentId,
          unblockDescriptor: { owner: "board", action: "Restore the reviewer" },
        });
      expect(hold.status, JSON.stringify(hold.body)).toBe(200);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.assigneeAgentId).toBe(seeded.replacementAgentId);
      expect(row.executionState).toEqual({
        ...seeded.executionState,
        currentParticipant: { type: "agent", agentId: seeded.replacementAgentId, userId: null },
        reviewRequest: null,
        monitor: null,
      });
      await settleWakes();
      expect(await allWakes(seeded.replacementAgentId)).toHaveLength(0);
      expect(await allWakes(seeded.reviewerAgentId)).toHaveLength(0);

      const edit = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ priority: "high" });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      await settleWakes();
      expect(await allWakes(seeded.replacementAgentId)).toHaveLength(0);
      expect(await allWakes(seeded.reviewerAgentId)).toHaveLength(0);

      const restore = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "in_review" });
      expect(restore.status, JSON.stringify(restore.body)).toBe(200);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("in_review");
      expect(row.assigneeAgentId).toBe(seeded.replacementAgentId);
      expect(row.executionState).toMatchObject({
        status: "pending",
        currentParticipant: { type: "agent", agentId: seeded.replacementAgentId },
        returnAssignee: seeded.executionState.returnAssignee,
        changesRequestedCount: count,
      });
      await vi.waitFor(async () => {
        expect(await reviewWakes(seeded.replacementAgentId)).toHaveLength(1);
      });
      await settleWakes();
      expect(await allWakes(seeded.replacementAgentId)).toHaveLength(1);
      expect(await reviewWakes(seeded.replacementAgentId)).toHaveLength(1);
      expect(await allWakes(seeded.reviewerAgentId)).toHaveLength(0);
    });

    it("rejects blocking the review while reassigning it outside the stage without writing", async () => {
      const seeded = await seedHeldReview(count, "in_review");

      const res = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({
          status: "blocked",
          assigneeAgentId: null,
          unblockDescriptor: { owner: "board", action: "Restore the reviewer" },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      const row = await readIssue(seeded.issueId);
      expect(row.status).toBe("in_review");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);
    });

    it.each(["todo", "in_progress"])("rejects a board PATCH to %s on the held review without writing", async (status) => {
      const seeded = await seedHeldReview(count, "blocked");

      const res = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status, comment: "Move it along." });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      const row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(0);
    });

    it("keeps the hold when a board user comments through PATCH or the comment route", async () => {
      const seeded = await seedHeldReview(count, "blocked");

      const patchComment = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ comment: "Still waiting on the reviewer." });
      expect(patchComment.status, JSON.stringify(patchComment.body)).toBe(200);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);

      const routeComment = await request(seeded.board)
        .post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Still waiting on the reviewer." });
      expect(routeComment.status, JSON.stringify(routeComment.body)).toBe(201);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(2);
    });

    it("rejects a board PATCH reopen and keeps the cycle on an explicit comment-route reopen", async () => {
      const seeded = await seedHeldReview(count, "blocked");

      const patchReopen = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ comment: "Reopen it.", reopen: true });
      expect(patchReopen.status, JSON.stringify(patchReopen.body)).toBe(422);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(0);

      const routeReopen = await request(seeded.board)
        .post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Reopen it.", reopen: true });
      expect(routeReopen.status, JSON.stringify(routeReopen.body)).toBe(201);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("todo");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);
      const decisions = await db
        .select()
        .from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
      expect(decisions).toHaveLength(0);
    });
  });
});
