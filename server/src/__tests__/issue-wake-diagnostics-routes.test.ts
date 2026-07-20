import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
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
    `Skipping embedded Postgres wake diagnostic route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
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

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "Wake Diagnostics") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `WD${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    parentId?: string | null;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function blockIssue(db: Db, companyId: string, blockerIssueId: string, blockedIssueId: string) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

async function attachLowTrustRun(db: Db, fixture: {
  company: CompanyRow;
  agent: AgentRow;
  allowedProject: ProjectRow;
  root: IssueRow;
  visibleBlocker: IssueRow;
}) {
  const executionPolicy = {
    authorizationPolicy: {
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: fixture.company.id,
        projectIds: [fixture.allowedProject.id],
        rootIssueId: fixture.root.id,
        issueIds: [fixture.root.id, fixture.visibleBlocker.id],
        allowedAgentIds: [],
      },
    },
  };
  await db.update(agents).set({
    permissions: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: executionPolicy.authorizationPolicy,
    },
  }).where(eq(agents.id, fixture.agent.id));
  fixture.agent.permissions = {
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    authorizationPolicy: executionPolicy.authorizationPolicy,
  };

  const [run] = await db.insert(heartbeatRuns).values({
    companyId: fixture.company.id,
    agentId: fixture.agent.id,
    status: "running",
    contextSnapshot: {
      issueId: fixture.root.id,
      executionPolicy,
    },
  }).returning();
  await db.update(issues).set({
    assigneeAgentId: fixture.agent.id,
    checkoutRunId: run!.id,
    executionRunId: run!.id,
    executionPolicy,
  }).where(eq(issues.id, fixture.root.id));
  return run!;
}

describeEmbeddedPostgres("issue wake diagnostics route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-wake-diagnostics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns recent wake rows newest-first with a deterministic diagnosis", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wake target",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const wakeRunId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 2,
      payload: { issueId: issue.id, rawMarker: "SHOULD_NOT_LEAK" },
      runId: wakeRunId,
      requestedAt: new Date(Date.now() - 10_000),
      claimedAt: new Date(Date.now() - 9_000),
      finishedAt: new Date(Date.now() - 1_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("completed for issue_blockers_resolved"),
      likelyReason: expect.stringContaining("completed for issue_blockers_resolved"),
      wakeRequestCount: 1,
      activityRecordCount: 0,
      truncated: false,
      caps: { maxWakeRequests: 50, maxActivityRecords: 50, lookbackDays: 14 },
    });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      agentId: agent.id,
      runId: wakeRunId,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 2,
      failureClass: null,
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"details\"");
    expect(serialized).not.toContain("\"triggerDetail\"");
    expect(serialized).not.toContain("\"error\"");
  });

  it("returns null diagnosis for an unblocked issue with no wake history", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Quiet issue",
      status: "todo",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.likelyReason).toBeNull();
    expect(res.body.events).toEqual([]);
    expect(res.body.wakeRequestCount).toBe(0);
    expect(res.body.activityRecordCount).toBe(0);
  });

  it("infers Case-B never-enqueued blockers-resolved wake from visible blocker state", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocked root",
      status: "blocked",
      assigneeAgentId: agent.id,
    });
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Unfinished blocker",
      status: "in_progress",
    });
    await blockIssue(db, company.id, blocker.id, root.id);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.diagnosis).toContain("No wake row exists");
    expect(res.body.diagnosis).toContain("Unfinished blocker");
    expect(res.body.diagnosis).toContain("in_progress");
    expect(res.body.diagnosis).toContain("issue_blockers_resolved has not fired");
  });

  it("omits hidden blocker state from Case-B diagnosis for boundary-scoped agents", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const allowedProject = await seedProject(db, company.id, "Allowed");
    const hiddenProject = await seedProject(db, company.id, "Hidden");
    const hiddenMarker = `HIDDEN-WAKE-BLOCKER-${randomUUID()}`;
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Scoped root",
      status: "blocked",
    });
    const visibleBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Visible blocker",
      status: "in_progress",
    });
    const hiddenBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: hiddenProject.id,
      title: hiddenMarker,
      status: "cancelled",
    });
    await blockIssue(db, company.id, visibleBlocker.id, root.id);
    await blockIssue(db, company.id, hiddenBlocker.id, root.id);
    const run = await attachLowTrustRun(db, { company, agent, allowedProject, root, visibleBlocker });

    const res = await request(createApp(db, agentActor(company, agent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toContain("authorization boundary");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(hiddenBlocker.id);
    expect(serialized).not.toContain(hiddenMarker);
    expect(serialized).not.toContain("cancelled");

    const hiddenAgent = await seedAgent(db, company.id);
    const wakeRunId = randomUUID();
    const [activityRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: hiddenAgent.id,
      status: "succeeded",
    }).returning();
    const activityRunId = activityRun!.id;
    const holdId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: hiddenAgent.id,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 0,
      payload: { issueId: root.id },
      runId: wakeRunId,
      requestedAt: new Date(Date.now() - 5_000),
      claimedAt: new Date(Date.now() - 4_000),
      finishedAt: new Date(Date.now() - 3_000),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.tree_hold_wakeup_deferred",
      entityType: "issue",
      entityId: root.id,
      agentId: hiddenAgent.id,
      runId: activityRunId,
      details: {
        rootIssueId: root.id,
        agentId: hiddenAgent.id,
        holdId,
        source: "automation",
        requestedReason: "issue_blockers_resolved",
      },
      createdAt: new Date(Date.now() - 1_000),
    });

    const resWithEvents = await request(createApp(db, agentActor(company, agent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(resWithEvents.status, JSON.stringify(resWithEvents.body)).toBe(200);
    expect(resWithEvents.body.events).toHaveLength(2);
    const activityEvent = resWithEvents.body.events.find((event: { kind: string }) => event.kind === "activity");
    const wakeEvent = resWithEvents.body.events.find((event: { kind: string }) => event.kind === "wake_request");
    expect(activityEvent).toMatchObject({
      kind: "activity",
      agentId: null,
      runId: null,
      holdId: null,
    });
    expect(wakeEvent).toMatchObject({
      kind: "wake_request",
      agentId: null,
      runId: null,
    });
    const serializedWithEvents = JSON.stringify(resWithEvents.body);
    expect(serializedWithEvents).not.toContain(hiddenBlocker.id);
    expect(serializedWithEvents).not.toContain(hiddenMarker);
    expect(serializedWithEvents).not.toContain(hiddenAgent.id);
    expect(serializedWithEvents).not.toContain(wakeRunId);
    expect(serializedWithEvents).not.toContain(activityRunId);
    expect(serializedWithEvents).not.toContain(holdId);
  });

  it("denies cross-company issue reads", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);
    const projectA = await seedProject(db, companyA.id, "A");
    const issueA = await seedIssue(db, {
      companyId: companyA.id,
      projectId: projectA.id,
      title: "Company A issue",
      status: "blocked",
    });
    const [runB] = await db.insert(heartbeatRuns).values({
      companyId: companyB.id,
      agentId: agentB.id,
      status: "running",
      contextSnapshot: { issueId: issueA.id },
    }).returning();

    const res = await request(createApp(db, agentActor(companyB, agentB, runB!.id)))
      .get(`/api/issues/${issueA.id}/diagnostics/wakes`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("projects activity records and wake failures without raw blobs", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Held issue",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const rawMarker = `RAW-DETAIL-${randomUUID()}`;
    const [activityRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "succeeded",
    }).returning();
    const activityRunId = activityRun!.id;

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "unknown-private-reason",
      status: "failed",
      payload: { issueId: issue.id, privateValue: rawMarker },
      error: `secret stack ${rawMarker}`,
      requestedAt: new Date(Date.now() - 60_000),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.tree_hold_wakeup_deferred",
      entityType: "issue",
      entityId: issue.id,
      agentId: agent.id,
      runId: activityRunId,
      details: {
        rootIssueId: issue.id,
        holdId: "hold-safe",
        source: "automation",
        requestedReason: "issue_commented",
        triggerDetail: rawMarker,
        secret: rawMarker,
      },
      createdAt: new Date(Date.now() - 1_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toContain("deferred by an active issue-tree hold");
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toMatchObject({
      kind: "activity",
      action: "issue.tree_hold_wakeup_deferred",
      source: "automation",
      requestedReason: "issue_commented",
      agentId: agent.id,
      runId: activityRunId,
      holdId: "hold-safe",
      summary: "Wake was deferred because an active issue-tree hold was present.",
    });
    expect(res.body.events[1]).toMatchObject({
      kind: "wake_request",
      reason: "other",
      status: "failed",
      failureClass: "failed",
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(rawMarker);
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"details\"");
    expect(serialized).not.toContain("\"triggerDetail\"");
    expect(serialized).not.toContain("\"error\"");
  });

  it("caps wake output and reports truncation", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Noisy issue",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const wakeRows = [];
    for (let index = 0; index < 51; index += 1) {
      wakeRows.push({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        reason: "issue_commented",
        status: "completed",
        payload: { issueId: issue.id },
        requestedAt: new Date(Date.now() - index * 1_000),
      });
    }
    await db.insert(agentWakeupRequests).values(wakeRows);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.wakeRequestCount).toBe(50);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedSections).toEqual({ wakeRequests: true, activityRecords: false });
    expect(res.body.diagnosis).toContain("truncated to 50 wake requests");
    expect(res.body.caps).toEqual({ maxWakeRequests: 50, maxActivityRecords: 50, lookbackDays: 14 });
  });
});
