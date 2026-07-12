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
  issueComments,
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
    `Skipping embedded Postgres subtree diagnostic route tests on this host: ${
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

async function seedCompany(db: Db, label = "Subtree Diagnostics") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `SD${nonce.slice(0, 4).toUpperCase()}`,
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

async function attachMentionScopedLowTrustRun(db: Db, fixture: {
  company: CompanyRow;
  ownerAgent: AgentRow;
  mentionedAgent: AgentRow;
  allowedProject: ProjectRow;
  root: IssueRow;
}) {
  const executionPolicy = {
    authorizationPolicy: {
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: fixture.company.id,
        projectIds: [fixture.allowedProject.id],
        issueIds: [],
        allowedAgentIds: [],
      },
    },
  };
  await db.update(agents).set({
    permissions: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: executionPolicy.authorizationPolicy,
    },
  }).where(eq(agents.id, fixture.mentionedAgent.id));
  fixture.mentionedAgent.permissions = {
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    authorizationPolicy: executionPolicy.authorizationPolicy,
  };
  await db.insert(issueComments).values({
    companyId: fixture.company.id,
    issueId: fixture.root.id,
    authorAgentId: fixture.ownerAgent.id,
    body: `[@Mentioned Agent](agent://${fixture.mentionedAgent.id}) please inspect this root.`,
  });
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: fixture.company.id,
    agentId: fixture.mentionedAgent.id,
    status: "running",
    contextSnapshot: {
      issueId: fixture.root.id,
      executionPolicy,
    },
  }).returning();
  return run!;
}

describeEmbeddedPostgres("issue subtree diagnostics route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-subtree-diagnostics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
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

  it("returns visible subtree nodes, blocker edges, wake edges, and a deterministic stall diagnosis", async () => {
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
    const child = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      parentId: root.id,
      title: "Unfinished child blocker",
      status: "in_progress",
    });
    const rawMarker = `RAW-SUBTREE-${randomUUID()}`;
    await blockIssue(db, company.id, child.id, root.id);
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "issue_commented",
      status: "completed",
      payload: { issueId: child.id, privateValue: rawMarker },
      error: `secret ${rawMarker}`,
      requestedAt: new Date(Date.now() - 5_000),
      finishedAt: new Date(Date.now() - 1_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/subtree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("Blocked root appears to be the subtree stall point"),
      likelyReason: expect.stringContaining("Blocked root appears to be the subtree stall point"),
      nodeCount: 2,
      omittedUnauthorizedNodeCount: 0,
      truncated: false,
      caps: {
        maxDepth: 8,
        maxNodes: 100,
        maxBlockersPerNode: 20,
        maxWakeRequestsPerNode: 5,
        maxActivityRecordsPerNode: 5,
        lookbackDays: 14,
      },
    });
    expect(res.body.nodes).toHaveLength(2);
    const rootNode = res.body.nodes.find((node: { issue: { id: string } }) => node.issue.id === root.id);
    const childNode = res.body.nodes.find((node: { issue: { id: string } }) => node.issue.id === child.id);
    expect(rootNode).toMatchObject({
      diagnosis: expect.stringContaining("blocked by Unfinished child blocker"),
      blockers: [expect.objectContaining({ id: child.id, status: "in_progress", isUnresolved: true })],
    });
    expect(childNode).toMatchObject({
      parentId: root.id,
      depth: 1,
      wakeRequestCount: 1,
      wakeEvents: [expect.objectContaining({ kind: "wake_request", reason: "issue_commented", status: "completed" })],
    });
    expect(res.body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "parent", fromIssueId: root.id, toIssueId: child.id }),
      expect.objectContaining({ kind: "blocks", fromIssueId: child.id, toIssueId: root.id }),
      expect.objectContaining({ kind: "wake_request", issueId: child.id, reason: "issue_commented" }),
    ]));
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(rawMarker);
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"details\"");
    expect(serialized).not.toContain("\"triggerDetail\"");
    expect(serialized).not.toContain("\"error\"");
  });

  it("returns null diagnosis for a quiet unblocked singleton subtree", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Quiet root",
      status: "todo",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/subtree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.likelyReason).toBeNull();
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0]).toMatchObject({
      diagnosis: null,
      likelyReason: null,
      blockers: [],
      wakeEvents: [],
      truncated: false,
    });
    expect(res.body.edges).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it("caps subtree nodes and reports truncation explicitly", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wide root",
      status: "todo",
    });
    const childRows = [];
    for (let index = 0; index < 100; index += 1) {
      childRows.push({
        companyId: company.id,
        projectId: project.id,
        parentId: root.id,
        title: `Child ${String(index).padStart(3, "0")}`,
        status: "todo",
        priority: "medium",
        responsibleUserId: "board-user",
      });
    }
    await db.insert(issues).values(childRows);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/subtree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.nodes).toHaveLength(100);
    expect(res.body.nodeCount).toBe(100);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedSections).toMatchObject({ nodes: true });
    expect(res.body.omittedUnauthorizedNodeCount).toBeNull();
    expect(res.body.diagnosis).toContain("bounded to depth 8 and 100 nodes");
  });

  it("omits subtree nodes outside a mention-scoped actor's issue-read grant", async () => {
    const company = await seedCompany(db);
    const ownerAgent = await seedAgent(db, company.id);
    const mentionedAgent = await seedAgent(db, company.id);
    const allowedProject = await seedProject(db, company.id, "Allowed");
    const targetProject = await seedProject(db, company.id, "Target");
    const hiddenMarker = `HIDDEN-SUBTREE-${randomUUID()}`;
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: targetProject.id,
      title: "Mention-visible root",
      status: "todo",
      assigneeAgentId: ownerAgent.id,
    });
    const hiddenChild = await seedIssue(db, {
      companyId: company.id,
      projectId: targetProject.id,
      parentId: root.id,
      title: hiddenMarker,
      status: "blocked",
    });
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: ownerAgent.id,
      source: "automation",
      reason: "issue_commented",
      status: "failed",
      payload: { issueId: hiddenChild.id, privateValue: hiddenMarker },
      error: `secret ${hiddenMarker}`,
      requestedAt: new Date(Date.now() - 5_000),
    });
    const run = await attachMentionScopedLowTrustRun(db, {
      company,
      ownerAgent,
      mentionedAgent,
      allowedProject,
      root,
    });

    const res = await request(createApp(db, agentActor(company, mentionedAgent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/subtree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0].issue.id).toBe(root.id);
    expect(res.body.omittedUnauthorizedNodeCount).toBe(1);
    expect(res.body.diagnosis).toContain("authorization boundary");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(hiddenChild.id);
    expect(serialized).not.toContain(hiddenMarker);
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"error\"");
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
      .get(`/api/issues/${issueA.id}/diagnostics/subtree`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });
});
