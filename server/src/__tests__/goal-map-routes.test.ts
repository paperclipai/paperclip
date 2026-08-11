import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GoalMapEdge, GoalMapNode, GoalMapResponse } from "@paperclipai/shared";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  goals,
  issuePlanDecompositions,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { goalRoutes } from "../routes/goals.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal map route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goal map routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-map-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issuePlanDecompositions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return { companyId };
  }

  async function seedGoalGraph(companyId: string) {
    const rootGoalId = randomUUID();
    const goalAId = randomUUID();
    const goalBId = randomUUID();
    await db.insert(goals).values([
      { id: rootGoalId, companyId, title: "Profitable autonomous trading", level: "company", status: "active" },
      { id: goalAId, companyId, title: "Verify market data", level: "team", status: "active", parentId: rootGoalId },
      { id: goalBId, companyId, title: "Funding strategy", level: "team", status: "planned", parentId: rootGoalId },
    ]);

    const a1Id = randomUUID();
    const a2Id = randomUUID();
    const a2ChildId = randomUUID();
    const hiddenId = randomUUID();
    const b1Id = randomUUID();
    await db.insert(issues).values([
      { id: a1Id, companyId, goalId: goalAId, title: "Collect ticks", status: "done", completedAt: new Date() },
      {
        id: a2Id,
        companyId,
        goalId: goalAId,
        title: "Launch MDCs",
        status: "todo",
        rationale: "Verify tick data so strategies can trust the lake",
      },
      { id: a2ChildId, companyId, goalId: goalAId, parentId: a2Id, title: "Backfill quotes", status: "backlog" },
      { id: hiddenId, companyId, goalId: goalAId, title: "Hidden noise", status: "backlog", hiddenAt: new Date() },
      { id: b1Id, companyId, goalId: goalBId, title: "Write funding strategy", status: "backlog" },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: a2Id,
      relatedIssueId: b1Id,
      type: "blocks",
    });

    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "plan body" });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      body: "plan body",
    });
    await db.insert(issuePlanDecompositions).values({
      companyId,
      sourceIssueId: a2Id,
      acceptedPlanRevisionId: revisionId,
      status: "completed",
      requestFingerprint: "test-fingerprint",
      requestedChildCount: 1,
      requestedChildren: [{ title: "Backfill quotes" }],
      childIssueIds: [a2ChildId],
      completedAt: new Date(),
    });

    return { rootGoalId, goalAId, goalBId, a1Id, a2Id, a2ChildId, b1Id };
  }

  function nodeById(body: GoalMapResponse, goalId: string): GoalMapNode {
    const node = body.nodes.find((n) => n.goal.id === goalId);
    expect(node, `expected goal-map node for goal ${goalId}`).toBeDefined();
    return node!;
  }

  function gateEdge(body: GoalMapResponse, fromGoalId: string, toGoalId: string): GoalMapEdge | undefined {
    return body.edges.find((e) => e.kind === "gates" && e.fromGoalId === fromGoalId && e.toGoalId === toGoalId);
  }

  it("returns goal nodes with rollups, root issues, gates, and decompositions", async () => {
    const { companyId } = await seedCompany();
    const seeded = await seedGoalGraph(companyId);
    const app = createApp(companyId);

    const response = await request(app).get(`/api/companies/${companyId}/goal-map`);
    expect(response.status).toBe(200);
    const body = response.body as GoalMapResponse;
    expect(body.nodes).toHaveLength(3);

    const nodeA = nodeById(body, seeded.goalAId);
    expect(nodeA.counts).toMatchObject({ total: 3, done: 1, todo: 1, backlog: 1 });
    const rootIssueIds = nodeA.rootIssues.map((issue) => issue.id).sort();
    expect(rootIssueIds).toEqual([seeded.a1Id, seeded.a2Id].sort());
    const a2 = nodeA.rootIssues.find((issue) => issue.id === seeded.a2Id);
    expect(a2?.rationale).toBe("Verify tick data so strategies can trust the lake");
    expect(nodeA.gated).toBe(false);
    expect(nodeA.decompositions).toHaveLength(1);
    expect(nodeA.decompositions[0]).toMatchObject({
      sourceIssueId: seeded.a2Id,
      status: "completed",
      childCount: 1,
    });

    const nodeB = nodeById(body, seeded.goalBId);
    expect(nodeB.counts.total).toBe(1);
    expect(nodeB.gated).toBe(true);
    expect(nodeB.inboundOpenGateCount).toBe(1);

    const rootNode = nodeById(body, seeded.rootGoalId);
    expect(rootNode.counts.total).toBe(0);
    expect(rootNode.subtreeCounts.total).toBe(4);
    expect(rootNode.subtreeCounts.done).toBe(1);

    const parentEdges = body.edges.filter((e) => e.kind === "parent");
    expect(parentEdges).toEqual(expect.arrayContaining([
      { kind: "parent", fromGoalId: seeded.rootGoalId, toGoalId: seeded.goalAId },
      { kind: "parent", fromGoalId: seeded.rootGoalId, toGoalId: seeded.goalBId },
    ]));

    const gate = gateEdge(body, seeded.goalAId, seeded.goalBId);
    expect(gate).toMatchObject({ kind: "gates", openIssueCount: 1, totalIssueCount: 1 });
  });

  it("clears the gate once the blocker issue is done", async () => {
    const { companyId } = await seedCompany();
    const seeded = await seedGoalGraph(companyId);
    const app = createApp(companyId);

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, seeded.a2Id));

    const response = await request(app).get(`/api/companies/${companyId}/goal-map`);
    expect(response.status).toBe(200);
    const body = response.body as GoalMapResponse;

    const gate = gateEdge(body, seeded.goalAId, seeded.goalBId);
    expect(gate).toMatchObject({ kind: "gates", openIssueCount: 0, totalIssueCount: 1 });
    const nodeB = nodeById(body, seeded.goalBId);
    expect(nodeB.gated).toBe(false);
    expect(nodeB.inboundOpenGateCount).toBe(0);
  });

  it("persists rationale through issue create and createChild", async () => {
    const { companyId } = await seedCompany();

    const parent = await issueService(db).create(companyId, {
      title: "Verify market data lake",
      status: "backlog",
      rationale: "The trading goal needs trustworthy ticks",
    });
    expect(parent.rationale).toBe("The trading goal needs trustworthy ticks");

    const child = await issueService(db).createChild(parent.id, {
      title: "Backfill 30d of quotes",
      status: "backlog",
      rationale: "Gap-free history is required before verification can start",
    });
    expect(child.issue.rationale).toBe("Gap-free history is required before verification can start");

    const childRow = await db
      .select({ rationale: issues.rationale })
      .from(issues)
      .where(eq(issues.id, child.issue.id))
      .then((rows) => rows[0]);
    expect(childRow?.rationale).toBe("Gap-free history is required before verification can start");
  });
});
