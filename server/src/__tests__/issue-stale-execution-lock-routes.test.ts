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
  issueRecoveryActions,
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
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
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

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

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
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
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

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("lets the current assignee recover a timed_out stale checkout owner during PATCH", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const timedOutRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId,
      status: "timed_out",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: timedOutRunId,
      executionRunId: timedOutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered stale checkout lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("still returns 409 when a different live checkout owner is active", async () => {
    const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveOwnerRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should fail" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("auto-cancels active recovery actions when issue transitions to done", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal transition auto-cancel",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `missing-disposition:${issueId}`,
      evidence: {},
      nextAction: "Choose a valid issue disposition.",
      attemptCount: 1,
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Completed stale lock recovery" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const action = await db
      .select({
        status: issueRecoveryActions.status,
        outcome: issueRecoveryActions.outcome,
        resolutionNote: issueRecoveryActions.resolutionNote,
      })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
  });

  it("allows board admin repair endpoint to cancel stale active recovery actions on terminal issues", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal issue with stale action",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: `missing-disposition:${issueId}:repair`,
      evidence: {},
      nextAction: "Choose a valid issue disposition.",
      attemptCount: 1,
    });

    await request(createApp(agentActor(companyId, agentId, randomUUID())))
      .post(`/api/issues/${issueId}/admin/repair-recovery-action`)
      .send()
      .expect(403);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/repair-recovery-action`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.repaired).toBe(true);
    expect(res.body.recoveryAction).toMatchObject({
      sourceIssueId: issueId,
      status: "cancelled",
      outcome: "cancelled",
    });
  });

  it("cancels only missing_disposition actions when moving to in_review with a typed reviewer", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();

    // Two separate issues: the unique constraint allows only one active action per source issue,
    // so we use one issue per action kind to verify selective cancellation.
    // The missing_disposition issue gets assigneeUserId pre-set so the service sees hasValidReviewer=true
    // when we PATCH to in_review (no assignee change → no tasks:assign permission check).
    const missingDispositionIssueId = randomUUID();
    const strandedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: missingDispositionIssueId,
        companyId,
        title: "Review path should clear missing disposition",
        status: "in_progress",
        priority: "medium",
        assigneeUserId: "reviewer-user",
        assigneeAgentId: null,
      },
      {
        id: strandedIssueId,
        companyId,
        title: "Review path should leave stranded action untouched",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const missingDispositionActionId = randomUUID();
    const strandedActionId = randomUUID();
    await db.insert(issueRecoveryActions).values([
      {
        id: missingDispositionActionId,
        companyId,
        sourceIssueId: missingDispositionIssueId,
        kind: "missing_disposition",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "successful_run_missing_issue_disposition",
        fingerprint: `missing-disposition:${missingDispositionIssueId}:in-review`,
        evidence: {},
        nextAction: "Choose a valid issue disposition.",
        attemptCount: 1,
      },
      {
        id: strandedActionId,
        companyId,
        sourceIssueId: strandedIssueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `stranded:${strandedIssueId}:in-review`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        attemptCount: 1,
      },
    ]);

    // Patch the missing_disposition issue to in_review. The issue already has assigneeUserId set,
    // so the service's hasValidReviewer check is true without changing the assignee (no tasks:assign
    // permission needed). Using boardActor bypasses the agent-only in_review disposition guard.
    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${missingDispositionIssueId}`)
      .send({ status: "in_review" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [missingDispositionRow] = await db
      .select({ id: issueRecoveryActions.id, kind: issueRecoveryActions.kind, status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, missingDispositionActionId));
    const [strandedRow] = await db
      .select({ id: issueRecoveryActions.id, kind: issueRecoveryActions.kind, status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, strandedActionId));

    // missing_disposition on the patched issue should be cancelled
    expect(missingDispositionRow).toMatchObject({
      kind: "missing_disposition",
      status: "cancelled",
      outcome: "cancelled",
    });
    // stranded action on a different issue should be untouched
    expect(strandedRow).toMatchObject({
      kind: "stranded_assigned_issue",
      status: "active",
      outcome: null,
    });
  });

  it("repairs all terminal-source stale recovery actions via /api/admin/recovery-actions/repair", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const doneIssueId = randomUUID();
    const cancelledIssueId = randomUUID();
    const liveIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: doneIssueId,
        companyId,
        title: "Done issue",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: cancelledIssueId,
        companyId,
        title: "Cancelled issue",
        status: "cancelled",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: liveIssueId,
        companyId,
        title: "Live issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRecoveryActions).values([
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: doneIssueId,
        kind: "missing_disposition",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "successful_run_missing_issue_disposition",
        fingerprint: `repair:done:${doneIssueId}`,
        evidence: {},
        nextAction: "Choose a valid issue disposition.",
        attemptCount: 1,
      },
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: cancelledIssueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `repair:cancelled:${cancelledIssueId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        attemptCount: 1,
      },
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: liveIssueId,
        kind: "missing_disposition",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "successful_run_missing_issue_disposition",
        fingerprint: `repair:live:${liveIssueId}`,
        evidence: {},
        nextAction: "Choose a valid issue disposition.",
        attemptCount: 1,
      },
    ]);

    const res = await request(createApp(boardActor(companyId)))
      .post("/api/admin/recovery-actions/repair")
      .send({ companyId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      companyId,
      scannedCount: 2,
      repairedCount: 2,
    });
  });
});
