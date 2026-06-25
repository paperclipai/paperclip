import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  crossCompanyAgentGrants,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR, TWX_CROSS_COMPANY_SOURCE_COMPANY_ID } from "../services/cross-company-agent-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const TEST_SOURCE_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE_MS = 60 * 1000;

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * MINUTE_MS);
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { managementRoutes } = await import("../routes/management.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", managementRoutes(db));
  app.use("/api", approvalRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompany(db: Db, id: string | undefined, label: string) {
  return db
    .insert(companies)
    .values({
      ...(id ? { id } : {}),
      name: `Management ${label} ${randomUUID()}`,
      issuePrefix: `MG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(
  db: Db,
  companyId: string,
  label: string,
  status = "idle",
  role = "engineer",
  permissions: Record<string, unknown> = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${label} ${randomUUID()}`,
      role,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions,
      status,
      lastHeartbeatAt: minutesAgo(30),
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedProject(db: Db, companyId: string, label: string, status = "in_progress") {
  return db
    .insert(projects)
    .values({
      companyId,
      name: `Project ${label} ${randomUUID()}`,
      status,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedIssue(db: Db, input: {
  companyId: string;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  title: string;
  status: string;
  priority?: string;
  identifier: string;
}) {
  return db
    .insert(issues)
    .values({
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      title: input.title,
      status: input.status,
      priority: input.priority ?? "medium",
      identifier: input.identifier,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("management routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAllowedSourceCompanyIds =
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-management-routes-");
    db = createDb(tempDb.connectionString);
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] = TEST_SOURCE_COMPANY_ID;
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(crossCompanyAgentGrants);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousAllowedSourceCompanyIds === undefined) {
      delete process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];
    } else {
      process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] =
        previousAllowedSourceCompanyIds;
    }
    await tempDb?.cleanup();
  });

  it("lets granted source-company agents read cross-company management summaries without widening writes", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "Source");
    const targetCompany = await seedCompany(db, undefined, "Target");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "Source");
    const targetAgent = await seedAgent(db, targetCompany.id, "Target", "running");
    const sourceRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: sourceCompany.id,
        agentId: sourceAgent.id,
        status: "succeeded",
        invocationSource: "assignment",
        livenessState: "completed",
        startedAt: minutesAgo(45),
        finishedAt: minutesAgo(42),
      })
      .returning()
      .then((rows) => rows[0]!);
    const targetProject = await seedProject(db, targetCompany.id, "Ops");
    await seedProject(db, targetCompany.id, "Completed", "completed");
    const blockerIssue = await seedIssue(db, {
      companyId: targetCompany.id,
      projectId: targetProject.id,
      assigneeAgentId: targetAgent.id,
      title: "Recover active run",
      status: "in_progress",
      identifier: `${targetCompany.issuePrefix}-1`,
    });
    const blockedIssue = await seedIssue(db, {
      companyId: targetCompany.id,
      projectId: targetProject.id,
      assigneeAgentId: targetAgent.id,
      title: "Cross-org blocker issue",
      status: "blocked",
      identifier: `${targetCompany.issuePrefix}-2`,
    });

    await db.insert(issueRelations).values({
      companyId: targetCompany.id,
      issueId: blockerIssue.id,
      relatedIssueId: blockedIssue.id,
      type: "blocks",
    });

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: targetCompany.id,
        agentId: targetAgent.id,
        status: "running",
        invocationSource: "on_demand",
        livenessState: "blocked",
        startedAt: minutesAgo(35),
        lastOutputAt: minutesAgo(30),
        resultJson: { summary: "Run blocked on dependency", hidden: "nope" },
        contextSnapshot: { issueId: blockedIssue.id },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(issues)
      .set({ executionRunId: run.id })
      .where(eq(issues.id, blockedIssue.id));

    await db.insert(issueRecoveryActions).values({
      companyId: targetCompany.id,
      sourceIssueId: blockedIssue.id,
      kind: "active_run_watchdog",
      status: "active",
      cause: "stalled_run",
      fingerprint: `fp-${randomUUID()}`,
      nextAction: "Inspect blocked dependency",
      ownerAgentId: targetAgent.id,
      evidence: {},
    });

    await db.insert(approvals).values({
      companyId: targetCompany.id,
      type: "request_board_approval",
      requestedByAgentId: targetAgent.id,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        title: "Approve ops change",
        summary: "Need read-only confirmation",
        recommendedAction: "Keep it read-only",
        secret: "must-not-leak",
      },
    });
    const rejectedApproval = await db
      .insert(approvals)
      .values({
        companyId: targetCompany.id,
        type: "request_board_approval",
        requestedByAgentId: targetAgent.id,
        requestedByUserId: "board-user",
        status: "rejected",
        decidedByUserId: "board-user",
        decidedAt: minutesAgo(22),
        payload: {
          title: "Reject noisy rollout",
          summary: "Need a narrower rollout",
          recommendedAction: "Revise the scope first",
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(issueComments).values({
      companyId: targetCompany.id,
      issueId: blockedIssue.id,
      authorType: "user",
      authorUserId: "board-user",
      body:
        "Board note: blocker reports need clearer next actions and links so the daily analyzer can spot recurring ownership gaps quickly.",
      createdAt: minutesAgo(28),
      updatedAt: minutesAgo(28),
    });

    await db.insert(activityLog).values([
      {
        companyId: targetCompany.id,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: blockedIssue.id,
        details: {
          status: "blocked",
          assigneeUserId: "reviewer-1",
          source: "board_triage",
          _previous: {
            status: "todo",
            assigneeUserId: null,
          },
        },
        createdAt: minutesAgo(27),
      },
      {
        companyId: targetCompany.id,
        actorType: "user",
        actorId: "board-user",
        action: "approval.rejected",
        entityType: "approval",
        entityId: rejectedApproval.id,
        details: {
          type: rejectedApproval.type,
        },
        createdAt: minutesAgo(21),
      },
    ]);

    const routine = await db
      .insert(routines)
      .values({
        companyId: targetCompany.id,
        projectId: targetProject.id,
        parentIssueId: blockedIssue.id,
        title: "Daily self-improvement analyzer",
        description: "Cross-company rollup",
        assigneeAgentId: targetAgent.id,
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(routineRuns).values({
      companyId: targetCompany.id,
      routineId: routine.id,
      source: "schedule",
      status: "failed",
      triggeredAt: minutesAgo(20),
      failureReason: "grant missing",
      linkedIssueId: blockedIssue.id,
      createdAt: minutesAgo(20),
      updatedAt: minutesAgo(20),
    });

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "read",
      status: "active",
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
      runId: sourceRun.id,
    });

    const companiesRes = await request(app).get("/api/management/companies");
    expect(companiesRes.status, JSON.stringify(companiesRes.body)).toBe(200);
    expect(companiesRes.body.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetCompany.id,
        projectCount: 2,
        activeProjectCount: 1,
        blockedIssueCount: 1,
        pendingApprovalCount: 1,
        activeRunCount: 1,
        attentionRunCount: 1,
        recoveryActionCount: 1,
      }),
    ]));

    const detailRes = await request(app).get(`/api/management/companies/${targetCompany.id}`);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    expect(detailRes.body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetAgent.id, companyId: targetCompany.id }),
    ]));
    expect(detailRes.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetProject.id,
        openIssueCount: 2,
        blockedIssueCount: 1,
      }),
    ]));
    expect(detailRes.body.approvals).toEqual([]);

    const issuesRes = await request(app)
      .get(`/api/management/companies/${targetCompany.id}/issues`)
      .query({ status: "blocked" });
    expect(issuesRes.status, JSON.stringify(issuesRes.body)).toBe(200);
    expect(issuesRes.body.issues).toEqual([
      expect.objectContaining({
        id: blockedIssue.id,
        blockedByCount: 1,
        unresolvedBlockerCount: 1,
        blockedBy: [expect.objectContaining({ id: blockerIssue.id })],
        activeRecoveryAction: expect.objectContaining({
          kind: "active_run_watchdog",
          nextAction: "Inspect blocked dependency",
        }),
      }),
    ]);

    const runsRes = await request(app)
      .get(`/api/management/companies/${targetCompany.id}/runs`);
    expect(runsRes.status, JSON.stringify(runsRes.body)).toBe(403);
    expect(runsRes.body.error).toContain("management read boundary");

    const analyzerRes = await request(app)
      .get(`/api/management/companies/${targetCompany.id}/analyzer-snapshot`)
      .query({ windowHours: 24, evidenceLimit: 5 });
    expect(analyzerRes.status, JSON.stringify(analyzerRes.body)).toBe(200);
    expect(analyzerRes.body.access).toMatchObject({
      mode: "cross_company_grant",
      excerptPolicy: "redacted",
    });
    expect(analyzerRes.body.metrics).toMatchObject({
      boardCommentCount: 1,
      boardActionCount: 2,
      approvalRejectedCount: 1,
      statusChangeCount: 1,
      assignmentChangeCount: 1,
      attentionHeartbeatRunCount: 1,
      timerAttentionHeartbeatRunCount: 0,
      failedRoutineRunCount: 1,
    });
    expect(analyzerRes.body.evidence.boardComments).toEqual([
      expect.objectContaining({
        issueId: blockedIssue.id,
        issueApiPath: `/api/issues/${blockedIssue.id}`,
        commentApiPath: expect.stringContaining(`/api/issues/${blockedIssue.id}/comments/`),
        bodyExcerpt: expect.stringContaining("Board note: blocker reports"),
      }),
    ]);
    expect(analyzerRes.body.evidence.boardActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.updated",
        issueId: blockedIssue.id,
        detailsSummary: null,
      }),
      expect.objectContaining({
        action: "approval.rejected",
        entityId: rejectedApproval.id,
        detailsSummary: null,
      }),
    ]));
    expect(analyzerRes.body.evidence.statusChanges).toEqual([
      expect.objectContaining({
        issueId: blockedIssue.id,
        previousStatus: "todo",
        status: "blocked",
        assigneeUserId: "reviewer-1",
      }),
    ]);
    expect(analyzerRes.body.evidence.approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        approvalId: rejectedApproval.id,
        approvalApiPath: `/api/approvals/${rejectedApproval.id}`,
        payloadSummary: null,
      }),
    ]));
    expect(analyzerRes.body.evidence.attentionRuns).toEqual([
      expect.objectContaining({
        runId: run.id,
        attentionCategory: "issue_run",
        runIssuesApiPath: `/api/heartbeat-runs/${run.id}/issues`,
        issueId: blockedIssue.id,
        resultSummary: null,
      }),
    ]);
    expect(analyzerRes.body.evidence.routineRuns).toEqual([
      expect.objectContaining({
        routineId: routine.id,
        routineRunsApiPath: `/api/routines/${routine.id}/runs`,
        linkedIssueId: blockedIssue.id,
        failureReason: null,
      }),
    ]);
    expect(analyzerRes.body.evidence.blockedIssues).toEqual([
      expect.objectContaining({
        id: blockedIssue.id,
        title: blockedIssue.identifier,
        projectName: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        executionRunId: null,
        activeRecoveryAction: expect.objectContaining({
          nextAction: "redacted",
          ownerAgentId: null,
        }),
      }),
    ]);

    const auditRows = await db
      .select({
        companyId: activityLog.companyId,
        runId: activityLog.runId,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "cross_company_analyzer_snapshot.read"));
    expect(auditRows).toHaveLength(2);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: sourceCompany.id,
        runId: sourceRun.id,
        entityId: targetCompany.id,
        details: expect.objectContaining({
          sourceCompanyId: sourceCompany.id,
          targetCompanyId: targetCompany.id,
          excerptPolicy: "redacted",
        }),
      }),
      expect.objectContaining({
        companyId: targetCompany.id,
        runId: sourceRun.id,
        entityId: targetCompany.id,
      }),
    ]));

    const writeRes = await request(app)
      .post(`/api/companies/${targetCompany.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { title: "Mutating write" },
      });
    expect(writeRes.status).toBe(403);
  }, 15_000);

  it("separates timer-only attention heartbeats from issue-linked attention counts", async () => {
    const company = await seedCompany(db, undefined, "TimerSeparation");
    const agent = await seedAgent(db, company.id, "TimerSeparationAgent");
    const issue = await seedIssue(db, {
      companyId: company.id,
      assigneeAgentId: agent.id,
      title: "Investigate analyzer noise",
      status: "blocked",
      identifier: `${company.issuePrefix}-1`,
    });

    const issueRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        invocationSource: "assignment",
        livenessState: "blocked",
        startedAt: minutesAgo(60),
        lastOutputAt: minutesAgo(58),
        contextSnapshot: { issueId: issue.id },
        createdAt: minutesAgo(57),
        updatedAt: minutesAgo(57),
      })
      .returning()
      .then((rows) => rows[0]!);

    const timerRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        invocationSource: "automation",
        livenessState: "empty_response",
        startedAt: minutesAgo(56),
        lastOutputAt: minutesAgo(55),
        contextSnapshot: {},
        createdAt: minutesAgo(54),
        updatedAt: minutesAgo(54),
      })
      .returning()
      .then((rows) => rows[0]!);

    const app = await createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: issueRun.id,
    });

    const analyzerRes = await request(app)
      .get(`/api/management/companies/${company.id}/analyzer-snapshot`)
      .query({ windowHours: 24, evidenceLimit: 5 });
    expect(analyzerRes.status, JSON.stringify(analyzerRes.body)).toBe(200);
    expect(analyzerRes.body.metrics).toMatchObject({
      heartbeatRunCount: 2,
      attentionHeartbeatRunCount: 1,
      timerAttentionHeartbeatRunCount: 1,
      failedHeartbeatRunCount: 0,
    });
    expect(analyzerRes.body.evidence.attentionRuns).toEqual([
      expect.objectContaining({
        runId: timerRun.id,
        attentionCategory: "timer_telemetry",
        issueId: null,
        issueIdentifier: null,
        issueTitle: null,
      }),
      expect.objectContaining({
        runId: issueRun.id,
        attentionCategory: "issue_run",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
      }),
    ]);
  }, 15_000);

  it("lets same-company agents read full analyzer evidence without cross-company audit", async () => {
    const company = await seedCompany(db, undefined, "SameCompany");
    const agent = await seedAgent(db, company.id, "SameCompanyAgent");
    const project = await seedProject(db, company.id, "Ops");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      assigneeAgentId: agent.id,
      title: "Investigate repeated failures",
      status: "blocked",
      identifier: `${company.issuePrefix}-1`,
    });
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "failed",
        invocationSource: "assignment",
        livenessState: "failed",
        startedAt: minutesAgo(25),
        finishedAt: minutesAgo(22),
        resultJson: { summary: "Failure was caused by missing credentials" },
        contextSnapshot: { issueId: issue.id },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorType: "user",
      authorUserId: "board-user",
      body: "Same-company board note with enough detail to remain fully visible to the analyzer caller.",
      createdAt: minutesAgo(20),
      updatedAt: minutesAgo(20),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        status: "blocked",
        source: "board_triage",
        _previous: { status: "todo" },
      },
      createdAt: minutesAgo(19),
    });
    const routine = await db
      .insert(routines)
      .values({
        companyId: company.id,
        projectId: project.id,
        parentIssueId: issue.id,
        title: "Same-company analyzer",
        assigneeAgentId: agent.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(routineRuns).values({
      companyId: company.id,
      routineId: routine.id,
      source: "schedule",
      status: "failed",
      triggeredAt: minutesAgo(18),
      failureReason: "scheduler timeout with internal detail",
      linkedIssueId: issue.id,
      createdAt: minutesAgo(18),
      updatedAt: minutesAgo(18),
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: run.id,
    });

    const analyzerRes = await request(app)
      .get(`/api/management/companies/${company.id}/analyzer-snapshot`)
      .query({ windowHours: 24, evidenceLimit: 5 });
    expect(analyzerRes.status, JSON.stringify(analyzerRes.body)).toBe(200);
    expect(analyzerRes.body.access).toMatchObject({
      mode: "same_company",
      excerptPolicy: "full",
      grantId: null,
    });
    expect(analyzerRes.body.evidence.boardComments[0].bodyExcerpt).toContain(
      "Same-company board note with enough detail",
    );
    expect(analyzerRes.body.evidence.boardActions).toEqual([
      expect.objectContaining({
        action: "issue.updated",
        detailsSummary: expect.objectContaining({ status: "blocked" }),
      }),
    ]);
    expect(analyzerRes.body.evidence.attentionRuns).toEqual([
      expect.objectContaining({
        runId: run.id,
        attentionCategory: "issue_run",
        resultSummary: expect.objectContaining({ summary: expect.any(String) }),
      }),
    ]);
    expect(analyzerRes.body.evidence.routineRuns).toEqual([
      expect.objectContaining({
        routineId: routine.id,
        failureReason: "scheduler timeout with internal detail",
      }),
    ]);
    expect(analyzerRes.body.evidence.blockedIssues).toEqual([
      expect.objectContaining({
        id: issue.id,
        title: "Investigate repeated failures",
      }),
    ]);

    const auditRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "cross_company_analyzer_snapshot.read"));
    expect(auditRows).toHaveLength(0);
  }, 15_000);

  it("denies cross-company management reads without an active grant", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "SourceDenied");
    const targetCompany = await seedCompany(db, undefined, "TargetDenied");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "SourceDenied");
    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app).get(`/api/management/companies/${targetCompany.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("management read boundary");

    const analyzerRes = await request(app).get(
      `/api/management/companies/${targetCompany.id}/analyzer-snapshot`,
    );
    expect(analyzerRes.status).toBe(403);
    expect(analyzerRes.body.error).toContain("management read boundary");
  }, 15_000);

  it("lets instance-admin board actors read management company summaries without grants", async () => {
    const targetCompany = await seedCompany(db, undefined, "BoardReadable");
    const app = await createApp(db, {
      type: "board",
      userId: "instance-admin",
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/management/companies");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetCompany.id }),
    ]));
  }, 15_000);

  it("lets a granted source-company agent delegate a bounded issue to the target CEO with audit in both companies", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegSource");
    const targetCompany = await seedCompany(db, undefined, "DelegTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegSource");
    const targetCeo = await seedAgent(db, targetCompany.id, "DelegTargetCeo", "idle", "ceo");
    const sourceRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: sourceCompany.id,
        agentId: sourceAgent.id,
        status: "running",
        invocationSource: "assignment",
        livenessState: "completed",
        startedAt: minutesAgo(10),
      })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "delegate",
      status: "active",
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
      runId: sourceRun.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({
        title: "Adapt confirmation discipline instruction",
        description: "Board flagged unnecessary confirmation prompts; fix the routine instruction.",
        priority: "high",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.issue).toMatchObject({
      companyId: targetCompany.id,
      title: "Adapt confirmation discipline instruction",
      status: "todo",
      priority: "high",
      assigneeAgentId: targetCeo.id,
    });
    expect(res.body.access).toMatchObject({
      mode: "cross_company_grant",
      sourceCompanyId: sourceCompany.id,
    });

    const createdIssue = await db
      .select({
        companyId: issues.companyId,
        originKind: issues.originKind,
        originId: issues.originId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, res.body.issue.id))
      .then((rows) => rows[0]!);
    expect(createdIssue).toMatchObject({
      companyId: targetCompany.id,
      originKind: "cross_company_delegation",
      originId: sourceCompany.id,
      assigneeAgentId: targetCeo.id,
    });

    const auditRows = await db
      .select({ companyId: activityLog.companyId, runId: activityLog.runId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "cross_company_issue.delegated"));
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.companyId).sort()).toEqual(
      [sourceCompany.id, targetCompany.id].sort(),
    );
    expect(auditRows.every((row) => row.runId === sourceRun.id)).toBe(true);
  }, 30_000);

  it("increments grant usage on cross-company delegation and reports remaining quota", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegUsageSource");
    const targetCompany = await seedCompany(db, undefined, "DelegUsageTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegUsageSource");
    await seedAgent(db, targetCompany.id, "DelegUsageCeo", "idle", "ceo");

    const grant = await db
      .insert(crossCompanyAgentGrants)
      .values({
        sourceCompanyId: sourceCompany.id,
        principalType: "agent",
        principalId: sourceAgent.id,
        targetCompanyId: targetCompany.id,
        capability: "delegate",
        status: "active",
        maxUses: 2,
      })
      .returning()
      .then((rows) => rows[0]!);

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({ title: "First delegated issue" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.access).toMatchObject({
      mode: "cross_company_grant",
      grantUsedCount: 1,
      grantMaxUses: 2,
    });

    const stored = await db
      .select({ usedCount: crossCompanyAgentGrants.usedCount, lastUsedAt: crossCompanyAgentGrants.lastUsedAt })
      .from(crossCompanyAgentGrants)
      .where(eq(crossCompanyAgentGrants.id, grant.id))
      .then((rows) => rows[0]!);
    expect(stored.usedCount).toBe(1);
    expect(stored.lastUsedAt).not.toBeNull();
  }, 30_000);

  it("denies cross-company delegation once a max-uses grant is exhausted", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegExhaustedSource");
    const targetCompany = await seedCompany(db, undefined, "DelegExhaustedTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegExhaustedSource");
    await seedAgent(db, targetCompany.id, "DelegExhaustedCeo", "idle", "ceo");

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "delegate",
      status: "active",
      maxUses: 1,
      usedCount: 1,
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({ title: "Should be denied (exhausted)" });
    expect(res.status).toBe(403);

    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, targetCompany.id));
    expect(issueCount).toHaveLength(0);
  }, 30_000);

  it("denies cross-company delegation when the grant has expired", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegExpiredSource");
    const targetCompany = await seedCompany(db, undefined, "DelegExpiredTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegExpiredSource");
    await seedAgent(db, targetCompany.id, "DelegExpiredCeo", "idle", "ceo");

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "delegate",
      status: "active",
      expiresAt: minutesAgo(5),
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({ title: "Should be denied (expired)" });
    expect(res.status).toBe(403);

    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, targetCompany.id));
    expect(issueCount).toHaveLength(0);
  }, 30_000);

  it("denies cross-company delegation when only a read grant exists", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegReadOnlySource");
    const targetCompany = await seedCompany(db, undefined, "DelegReadOnlyTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegReadOnlySource");
    await seedAgent(db, targetCompany.id, "DelegReadOnlyCeo", "idle", "ceo");

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "read",
      status: "active",
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({ title: "Should be denied" });
    expect(res.status).toBe(403);

    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, targetCompany.id));
    expect(issueCount).toHaveLength(0);
  }, 30_000);

  it("rejects a delegated assignee that is not in the target company", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "DelegBadAssigneeSource");
    const targetCompany = await seedCompany(db, undefined, "DelegBadAssigneeTarget");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "DelegBadAssigneeSource");
    await seedAgent(db, targetCompany.id, "DelegBadAssigneeCeo", "idle", "ceo");

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "delegate",
      status: "active",
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${targetCompany.id}/delegated-issues`)
      .send({ title: "Wrong company assignee", assigneeAgentId: sourceAgent.id });
    // Rejected at the authorization layer (assignee not in the target company)
    // before any issue is created.
    expect(res.status).toBe(403);

    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, targetCompany.id));
    expect(issueCount).toHaveLength(0);
  }, 30_000);

  it("lets a standard same-company agent delegate to its own CEO with a single same-company audit row", async () => {
    const company = await seedCompany(db, undefined, "SameCoDeleg");
    const ceo = await seedAgent(db, company.id, "SameCoDelegCeo", "idle", "ceo");
    const engineer = await seedAgent(db, company.id, "SameCoDelegEng");

    const app = await createApp(db, {
      type: "agent",
      agentId: engineer.id,
      companyId: company.id,
    });

    const res = await request(app)
      .post(`/api/management/companies/${company.id}/delegated-issues`)
      .send({ title: "Same-company delegated issue", priority: "low" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.issue).toMatchObject({
      companyId: company.id,
      assigneeAgentId: ceo.id,
      status: "todo",
    });
    expect(res.body.access).toMatchObject({ mode: "same_company", grantId: null });

    const auditRows = await db
      .select({ companyId: activityLog.companyId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, res.body.issue.id));
    expect(auditRows.filter((r) => r.action === "issue.delegated")).toEqual([
      expect.objectContaining({ companyId: company.id, action: "issue.delegated" }),
    ]);
    expect(auditRows.some((r) => r.action === "cross_company_issue.delegated")).toBe(false);
  }, 30_000);

  it("denies a low-trust same-company agent from delegating outside its boundary (no assignment bypass)", async () => {
    const company = await seedCompany(db, undefined, "LowTrustDeleg");
    const ceo = await seedAgent(db, company.id, "LowTrustDelegCeo", "idle", "ceo");
    const lowTrust = await seedAgent(db, company.id, "LowTrustDelegEng", "idle", "engineer", {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: {
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          projectIds: [],
          rootIssueId: randomUUID(),
        },
      },
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: lowTrust.id,
      companyId: company.id,
    });

    // The CEO and a no-project top-level issue are both outside the low-trust
    // boundary, so delegation must be denied — it cannot be used to bypass the
    // assignment/low-trust checks that gate normal issue creation.
    const res = await request(app)
      .post(`/api/management/companies/${company.id}/delegated-issues`)
      .send({ title: "Low-trust delegation attempt", assigneeAgentId: ceo.id });
    expect(res.status).toBe(403);

    const issueCount = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, company.id));
    expect(issueCount).toHaveLength(0);
  }, 30_000);
});
