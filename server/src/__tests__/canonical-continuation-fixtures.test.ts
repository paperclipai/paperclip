import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
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
    `Skipping canonical-continuation fixtures on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type IssueStatus = typeof issues.$inferInsert.status;

function createApp(db: Db, company: CompanyRow) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db, label: string) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `CC${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Fixture Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning();
  return agent!;
}

async function seedIssue(db: Db, input: {
  companyId: string;
  title: string;
  status: IssueStatus;
  parentId?: string | null;
  assigneeAgentId?: string | null;
}) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    title: input.title,
    status: input.status,
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    priority: "medium",
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

async function snapshotDiagnosticInputs(db: Db, companyId: string) {
  const [issueRows, blockerEdges, runMarkers] = await Promise.all([
    db.select({
      id: issues.id,
      parentId: issues.parentId,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    }).from(issues).where(eq(issues.companyId, companyId)).orderBy(asc(issues.id)),
    db.select({
      id: issueRelations.id,
      issueId: issueRelations.issueId,
      relatedIssueId: issueRelations.relatedIssueId,
      type: issueRelations.type,
      createdAt: issueRelations.createdAt,
      updatedAt: issueRelations.updatedAt,
    }).from(issueRelations).where(eq(issueRelations.companyId, companyId)).orderBy(asc(issueRelations.id)),
    db.select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      finishedAt: heartbeatRuns.finishedAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.id)),
  ]);
  return { issueRows, blockerEdges, runMarkers };
}

function healthFor(response: any, issueId: string) {
  const health = response.body.treeHealth.nodes.find((node: { issueId: string }) => node.issueId === issueId);
  expect(health, `missing tree-health entry for ${issueId}`).toBeDefined();
  return health;
}

function assertEveryNodeIsSelfCanonical(response: any) {
  expect(response.body.treeHealth.nodes).toHaveLength(response.body.nodes.length);
  for (const node of response.body.treeHealth.nodes) {
    expect(node).toMatchObject({
      canonicalContinuationId: node.issueId,
      continuationCount: 1,
    });
  }
}

async function readDiagnostics(db: Db, company: CompanyRow, root: IssueRow, query?: Record<string, number>) {
  const before = await snapshotDiagnosticInputs(db, company.id);
  const response = await request(createApp(db, company))
    .get(`/api/issues/${root.id}/diagnostics/subtree`)
    .query(query ?? {});
  const after = await snapshotDiagnosticInputs(db, company.id);

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(after).toEqual(before);
  assertEveryNodeIsSelfCanonical(response);
  return response;
}

describeEmbeddedPostgres("canonical-continuation regression fixtures", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-canonical-continuation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps legitimate parallel convergence as independent execution continuations", async () => {
    const company = await seedCompany(db, "Parallel convergence");
    const agent = await seedAgent(db, company.id);
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Converge independent work",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });
    const first = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Convergent implementation",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });
    const second = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "  convergent   implementation ",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });
    await db.update(issues).set({
      createdAt: new Date(first.createdAt.getTime() + 1_000),
    }).where(eq(issues.id, second.id));

    const response = await readDiagnostics(db, company, root);

    expect(healthFor(response, root.id)).toMatchObject({ unresolvedPathType: "execution" });
    expect(healthFor(response, first.id)).toMatchObject({ unresolvedPathType: "execution" });
    expect(healthFor(response, second.id)).toMatchObject({ unresolvedPathType: "execution" });
    expect(response.body.treeHealth.supersessionCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ predecessorIssueId: first.id, successorIssueId: second.id }),
    ]));
    expect(response.body.nodes.map((node: { issue: { id: string } }) => node.issue.id)).toEqual(
      expect.arrayContaining([root.id, first.id, second.id]),
    );
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "blocks")).toEqual([]);
  });

  it("keeps a completed partial review separate from its explicit execution survivor", async () => {
    const company = await seedCompany(db, "Partial review survivor");
    const agent = await seedAgent(db, company.id);
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Complete partial review",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });
    const completedReview = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Review completed portion",
      status: "done",
    });
    const survivor = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Review residual survivor",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });

    const response = await readDiagnostics(db, company, root);

    expect(healthFor(response, completedReview.id)).toMatchObject({ unresolvedPathType: "none" });
    expect(healthFor(response, survivor.id)).toMatchObject({ unresolvedPathType: "execution" });
    expect(response.body.nodes.find((node: { issue: { id: string } }) => node.issue.id === survivor.id)).toMatchObject({
      parentId: root.id,
      issue: { status: "in_progress" },
    });
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "blocks")).toEqual([]);
  });

  it("classifies an unblocked blocked leaf as an external wait without inventing a blocker", async () => {
    const company = await seedCompany(db, "External blocked leaf");
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Await external response",
      status: "blocked",
    });

    const response = await readDiagnostics(db, company, root);

    expect(healthFor(response, root.id)).toMatchObject({ unresolvedPathType: "external" });
    expect(response.body.nodes[0]).toMatchObject({
      issue: { id: root.id, status: "blocked" },
      blockers: [],
      blockerReadiness: expect.objectContaining({ unresolvedBlockerIssueIds: [] }),
    });
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "blocks")).toEqual([]);
  });

  it("classifies a reciprocal blocker ring as a cycle while preserving both issue identities", async () => {
    const company = await seedCompany(db, "Blocker ring");
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Resolve blocker ring",
      status: "in_progress",
    });
    const left = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Left blocker",
      status: "blocked",
    });
    const right = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Right blocker",
      status: "blocked",
    });
    await blockIssue(db, company.id, left.id, right.id);
    await blockIssue(db, company.id, right.id, left.id);

    const response = await readDiagnostics(db, company, root);

    expect(response.body.treeHealth.cycleStatus).toBe("detected");
    expect(healthFor(response, left.id)).toMatchObject({ unresolvedPathType: "cycle", cycleStatus: "detected" });
    expect(healthFor(response, right.id)).toMatchObject({ unresolvedPathType: "cycle", cycleStatus: "detected" });
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "blocks")).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromIssueId: left.id, toIssueId: right.id }),
      expect.objectContaining({ fromIssueId: right.id, toIssueId: left.id }),
    ]));
  });

  it("warns after two successful runs without later useful work while execution remains visible", async () => {
    const company = await seedCompany(db, "No progress warning");
    const agent = await seedAgent(db, company.id);
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Continue execution without progress",
      status: "in_progress",
      assigneeAgentId: agent.id,
    });
    const progressAt = new Date("2026-08-01T10:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        lastUsefulActionAt: progressAt,
        finishedAt: progressAt,
        contextSnapshot: { issueId: root.id },
      },
      {
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        finishedAt: new Date("2026-08-01T11:00:00.000Z"),
        contextSnapshot: { issueId: root.id },
      },
      {
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        finishedAt: new Date("2026-08-01T12:00:00.000Z"),
        contextSnapshot: { issueId: root.id },
      },
    ]);

    const response = await readDiagnostics(db, company, root, {
      successfulRunsWithoutProgressWarning: 2,
    });

    expect(healthFor(response, root.id)).toMatchObject({
      unresolvedPathType: "execution",
      successfulRunsSinceProgress: 2,
      successfulRunsWithoutProgressWarning: true,
    });
    expect(response.body.nodes).toHaveLength(1);
    expect(response.body.edges).toEqual([]);
  });
});
