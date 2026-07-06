import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

// Simulate the race where the recovery action is resolved/cancelled between
// the route-level getActiveForIssue check and the bumpFollowupAttempt UPDATE
// inside the transaction: the service returns null for the bump while every
// other method behaves normally.
vi.mock("../services/issue-recovery-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-recovery-actions.js")>();
  return {
    ...actual,
    issueRecoveryActionService: (dbOrTx: never) => {
      const svc = actual.issueRecoveryActionService(dbOrTx);
      return {
        ...svc,
        bumpFollowupAttempt: vi.fn(async () => null),
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres concurrent recovery comment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery-actions follow-up comment concurrent resolution", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-concurrent-comment-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 409 and rolls back the comment when the recovery action is resolved concurrently", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Concurrency Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:concurrent-resolution",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as never as { actor: unknown }).actor = {
        type: "agent",
        agentId: managerId,
        companyId,
        runId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const response = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/comment`)
      .send({ body: "Follow-up racing a concurrent resolution." })
      .expect(409);

    expect(response.body.error).toContain("concurrently");
    expect(response.body.details).toMatchObject({
      issueId: sourceIssueId,
      recoveryActionId: action.id,
    });

    // The comment insert must be rolled back, not committed as a partial success.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssueId));
    expect(comments).toHaveLength(0);

    // No follow-up activity entry should be recorded for the failed attempt.
    const activityRows = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(
      activityRows.filter((row) => row.action === "issue.recovery_action_followup_comment"),
    ).toHaveLength(0);
  });
});
