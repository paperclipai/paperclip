import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentScopedIssueListRoute } from "../routes/agent-scoped-issue-list.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task-bridge issue list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /agents/me/issues task_bridge fence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-bridge-issues-");
    db = createDb(tempDb.connectionString);
  }, 600_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appForActor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(agentScopedIssueListRoute(db));
    app.use(errorHandler);
    return app;
  }

  function taskBridgeActor(
    companyId: string,
    agentId: string,
    scope: {
      projectIds?: string[];
      parentIssueId?: string;
      allowedAssigneeAgentIds?: string[];
    },
  ): Express.Request["actor"] {
    return {
      type: "agent",
      source: "agent_key",
      agentId,
      companyId,
      keyId: "test-key",
      keyScope: { kind: "task_bridge", ...scope },
      companyIds: [companyId],
      memberships: [],
      isInstanceAdmin: false,
    };
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const outsideProjectId = randomUUID();
    const bridgeAgentId = randomUUID();
    const allowedPeerAgentId = randomUUID();
    const outsideAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Bridge test company",
      issuePrefix: `TB${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values([
      { id: projectAId, companyId, name: "Allowed A" },
      { id: projectBId, companyId, name: "Allowed B" },
      { id: outsideProjectId, companyId, name: "Outside" },
    ]);
    await db.insert(agents).values(
      [
        { id: bridgeAgentId, name: "Bridge" },
        { id: allowedPeerAgentId, name: "Allowed peer" },
        { id: outsideAgentId, name: "Outside agent" },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        status: "active" as const,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );

    const issueAId = randomUUID();
    const issueBId = randomUUID();
    const outsideProjectIssueId = randomUUID();
    const outsideAssigneeIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: issueAId,
        companyId,
        title: "Allowed A issue",
        status: "todo",
        priority: "medium",
        projectId: projectAId,
        assigneeAgentId: bridgeAgentId,
      },
      {
        id: issueBId,
        companyId,
        title: "Allowed B issue",
        status: "todo",
        priority: "medium",
        projectId: projectBId,
        assigneeAgentId: allowedPeerAgentId,
      },
      {
        id: outsideProjectIssueId,
        companyId,
        title: "Outside project issue",
        status: "todo",
        priority: "medium",
        projectId: outsideProjectId,
        assigneeAgentId: bridgeAgentId,
      },
      {
        id: outsideAssigneeIssueId,
        companyId,
        title: "Outside assignee issue",
        status: "todo",
        priority: "medium",
        projectId: projectAId,
        assigneeAgentId: outsideAgentId,
      },
    ]);

    return {
      companyId,
      projectAId,
      projectBId,
      outsideProjectId,
      bridgeAgentId,
      allowedPeerAgentId,
      outsideAgentId,
      issueAId,
      issueBId,
      outsideProjectIssueId,
      outsideAssigneeIssueId,
    };
  }

  it("lists all and only issues inside both scope dimensions", async () => {
    const fixture = await seedFixture();
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      projectIds: [fixture.projectAId, fixture.projectBId],
      allowedAssigneeAgentIds: [fixture.allowedPeerAgentId],
    });

    const res = await request(appForActor(actor)).get("/agents/me/issues");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.items.map((issue: { id: string }) => issue.id);
    expect(new Set(ids)).toEqual(new Set([fixture.issueAId, fixture.issueBId]));
    expect(ids).not.toContain(fixture.outsideProjectIssueId);
    expect(ids).not.toContain(fixture.outsideAssigneeIssueId);
    expect(res.body.hasMore).toBe(false);
  });

  it("returns 200 for an in-scope project and 403 for an out-of-scope project", async () => {
    const fixture = await seedFixture();
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      projectIds: [fixture.projectAId, fixture.projectBId],
      allowedAssigneeAgentIds: [fixture.allowedPeerAgentId],
    });

    const allowed = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ projectId: fixture.projectBId });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.items.map((issue: { id: string }) => issue.id)).toEqual([
      fixture.issueBId,
    ]);

    const denied = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ projectId: fixture.outsideProjectId });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error).toMatch(/outside this key's approved scope/);
  });

  it("refuses assignees outside the fence, including unassigned issues", async () => {
    const fixture = await seedFixture();
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      projectIds: [fixture.projectAId, fixture.projectBId],
    });

    const outsideAgent = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ assigneeAgentId: fixture.outsideAgentId });
    expect(outsideAgent.status, JSON.stringify(outsideAgent.body)).toBe(403);

    const unassigned = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ assigneeAgentId: "null" });
    expect(unassigned.status, JSON.stringify(unassigned.body)).toBe(403);
  });

  it("returns an explicit empty page for a parent-only bridge key", async () => {
    const fixture = await seedFixture();
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      parentIssueId: randomUUID(),
    });

    const res = await request(appForActor(actor)).get("/agents/me/issues");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it("applies q inside both task_bridge fence dimensions", async () => {
    const fixture = await seedFixture();
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      projectIds: [fixture.projectAId, fixture.projectBId],
      allowedAssigneeAgentIds: [fixture.allowedPeerAgentId],
    });

    const match = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ q: "Allowed B" });
    expect(match.status, JSON.stringify(match.body)).toBe(200);
    expect(match.body.items.map((issue: { id: string }) => issue.id)).toEqual([
      fixture.issueBId,
    ]);

    // Both records containing "Outside" sit beyond one side of the fence. The text
    // filter narrows the already-fenced set; it must never make either issue visible.
    const fenced = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ q: "Outside" });
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(200);
    expect(fenced.body.items).toEqual([]);
  });

  it("returns hasMore until the final page", async () => {
    const fixture = await seedFixture();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      title: "Third allowed issue",
      status: "todo",
      priority: "medium",
      projectId: fixture.projectAId,
      assigneeAgentId: fixture.bridgeAgentId,
    });
    const actor = taskBridgeActor(fixture.companyId, fixture.bridgeAgentId, {
      projectIds: [fixture.projectAId, fixture.projectBId],
      allowedAssigneeAgentIds: [fixture.allowedPeerAgentId],
    });

    const first = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ limit: "2" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);

    const second = await request(appForActor(actor))
      .get("/agents/me/issues")
      .query({ limit: "2", offset: "2" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.hasMore).toBe(false);
  });
});
