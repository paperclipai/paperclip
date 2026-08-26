import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV } from "../services/cross-issue-write-basis.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment auto-approval grading tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `POST /issues/:id/comments` grades its cross-issue authority by what the
 * request actually does, not by the route it arrived on. Auto-approval was the
 * one effect missing from that grade: an approval-shaped body on an `in_review`
 * target with a pending execution decision closes the issue and writes a
 * decision row, but the cap gate scored it as a plain comment — so a
 * comment-only basis (a sibling relationship, a shared routine origin) reached
 * a state transition on someone else's ticket (FAI-10134 finding 2).
 *
 * Both tests below are the same request against the same seed. The first pins
 * the grade recorded in the shadow dataset under today's observe-mode rollout;
 * the second pins the refusal and the absence of every effect once enforcement
 * is armed.
 */
describeEmbeddedPostgres("cross-issue comment auto-approval grading (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-grade-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueComments),
      () => db.delete(issueExecutionDecisions),
      () => db.delete(activityLog),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentId: string, runId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  const APPROVAL_BODY = "## Review: APPROVED\n\nLooks good to me.";

  /**
   * Actor A is the pending reviewer on target T, but T is held by agent B and
   * the run is working source issue S. S and T are siblings, so the actor's only
   * cross-issue authority is `target_shares_parent_with_source` — comment-grade,
   * and nothing more.
   */
  async function seed() {
    const companyId = randomUUID();
    const actorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const runId = randomUUID();
    const parentIssueId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const stageId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([actorAgentId, ownerAgentId].map((id, index) => ({
      id,
      companyId,
      name: index === 0 ? "Former Reviewer" : "Ticket Owner",
      role: "engineer",
      status: "idle" as const,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: actorAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values([
      { id: parentIssueId, companyId, title: "Epic", status: "in_progress", priority: "medium" },
      {
        id: sourceIssueId,
        companyId,
        parentId: parentIssueId,
        title: "The run's own task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: actorAgentId,
      },
      {
        id: targetIssueId,
        companyId,
        parentId: parentIssueId,
        title: "A sibling's task, awaiting review",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: ownerAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: actorAgentId, userId: null }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: actorAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: ownerAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
    ]);

    return { companyId, actorAgentId, ownerAgentId, runId, sourceIssueId, targetIssueId };
  }

  it("grades an auto-approving comment on a sibling's issue as a mutation in the shadow dataset", async () => {
    const { companyId, actorAgentId, runId, sourceIssueId, targetIssueId } = await seed();

    const res = await request(app(companyId, actorAgentId, runId))
      .post(`/api/issues/${targetIssueId}/comments`)
      .send({ body: APPROVAL_BODY });

    // Observe mode: the write still lands exactly as it does today — the route
    // has always answered a created comment with 201. Only the grade recorded
    // against it changes.
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const shadow = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.cross_issue_write_grant_would_deny"),
      ));
    // Before the fix there was no row at all: the sibling basis authorized the
    // write as a comment and the auto-approval rode in behind it.
    expect(shadow).toHaveLength(1);
    expect(shadow[0]?.details).toMatchObject({
      kind: "comment",
      operation: "mutation",
      sourceIssueId,
      targetIssueId,
      basis: null,
      commentOnlyBasis: "target_shares_parent_with_source",
    });
  }, 30_000);

  it("refuses the same comment under enforcement with no comment, decision, execution, or status effect", async () => {
    const previous = process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV];
    process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV] = "2026-01-01T00:00:00.000Z";
    try {
      const { companyId, actorAgentId, runId, targetIssueId } = await seed();

      const res = await request(app(companyId, actorAgentId, runId))
        .post(`/api/issues/${targetIssueId}/comments`)
        .send({ body: APPROVAL_BODY });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "cross_issue_write_grant_required" });

      const comments = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, targetIssueId));
      expect(comments).toEqual([]);

      const decisions = await db
        .select({ id: issueExecutionDecisions.id })
        .from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, targetIssueId));
      expect(decisions).toEqual([]);

      const [target] = await db
        .select({ status: issues.status, executionState: issues.executionState })
        .from(issues)
        .where(eq(issues.id, targetIssueId));
      expect(target?.status).toBe("in_review");
      expect(target?.executionState).toMatchObject({ status: "pending", lastDecisionId: null });
    } finally {
      if (previous === undefined) delete process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV];
      else process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV] = previous;
    }
  }, 30_000);
});
