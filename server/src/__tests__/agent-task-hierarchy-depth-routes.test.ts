import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("agent task hierarchy depth through the issue routes", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  const conversationId = randomUUID();
  const runOnChild = randomUUID();
  const runOnConversation = randomUUID();
  const legacyConversationChildId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-task-depth-routes-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: "DEP", defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", adapterType: "codex_local", status: "active" });
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Ship the feature", identifier: "DEP-1", issueNumber: 1, status: "in_progress", assigneeAgentId: agentId },
      { id: childId, companyId, parentId: rootId, title: "Build the API", identifier: "DEP-2", issueNumber: 2, status: "in_progress", assigneeAgentId: agentId },
      { id: conversationId, companyId, title: "Chat", identifier: "DEP-3", issueNumber: 3, status: "in_review", assigneeAgentId: agentId,
        conversationAgentId: agentId, conversationUserId: "board-user", conversationState: "waiting" },
    ]);
    await db.insert(issues).values({
      id: legacyConversationChildId, companyId, parentId: conversationId, title: "Legacy chat child",
      identifier: "DEP-4", issueNumber: 4, status: "todo", assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values([
      { id: runOnChild, companyId, agentId, scopeKind: "issue", issueId: childId, nativeIssueId: childId, status: "running", contextSnapshot: { issueId: childId } },
      { id: runOnConversation, companyId, agentId, scopeKind: "issue", issueId: conversationId, status: "running", contextSnapshot: { issueId: conversationId } },
    ]);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  const boardActor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true } as Express.Request["actor"];
  function agentActor(runId: string): Express.Request["actor"] {
    return { type: "agent", companyId, agentId, runId, source: "agent_jwt", onBehalfOfUserId: null, onBehalfOfMemberships: [] } as Express.Request["actor"];
  }
  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }
  async function activity(issueId: string, action: string) {
    const [row] = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
    return row ?? null;
  }
  const expectedAdjustment = {
    reason: "max_agent_depth",
    applied: true,
    requestedParent: { id: childId, identifier: "DEP-2" },
    effectiveParent: { id: rootId, identifier: "DEP-1" },
  };

  it("places a run's default follow-up beside the child task it is working on", async () => {
    const created = await request(app(agentActor(runOnChild)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Write the migration" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.parentId).toBe(rootId);
    expect(created.body.originIssueId).toBe(childId);
    expect(created.body.originRunId).toBe(runOnChild);
    expect(created.body.parentAdjusted).toEqual(expectedAdjustment);
    expect((await activity(created.body.id, "issue.created"))?.details).toMatchObject({
      parentId: rootId,
      parentAdjusted: expectedAdjustment,
      parentDefaultedFromRunIssue: true,
    });

    const detail = await request(app(boardActor)).get(`/api/issues/${created.body.id}`);
    expect(detail.body.createdFrom).toMatchObject({ issue: { id: childId, identifier: "DEP-2" } });
  });

  it("places an explicit agent grandchild beside the requester instead of failing", async () => {
    const created = await request(app(agentActor(runOnChild)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Add tests", parentId: childId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.parentId).toBe(rootId);
    expect(created.body.parentAdjusted).toEqual(expectedAdjustment);
  });

  it("places an agent child created through the children route beside the requester", async () => {
    const created = await request(app(agentActor(runOnChild)))
      .post(`/api/issues/${childId}/children`)
      .send({ title: "Update the docs" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.parentId).toBe(rootId);
    expect(created.body.originIssueId).toBe(childId);
    expect(created.body.parentAdjusted).toEqual(expectedAdjustment);
    expect((await activity(created.body.id, "issue.child_created"))?.details).toMatchObject({
      parentId: rootId,
      requestedParentId: childId,
    });
  });

  it("lets board users create grandchildren", async () => {
    const created = await request(app(boardActor))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Board grandchild", parentId: childId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.parentId).toBe(childId);
    expect(created.body).not.toHaveProperty("parentAdjusted");

    const viaChildren = await request(app(boardActor))
      .post(`/api/issues/${childId}/children`)
      .send({ title: "Board grandchild via children route" });
    expect(viaChildren.status, JSON.stringify(viaChildren.body)).toBe(201);
    expect(viaChildren.body.parentId).toBe(childId);
  });

  it("flattens agent moves into a child and lets board users move freely", async () => {
    const [agentMoved, boardMoved] = [randomUUID(), randomUUID()];
    await db.insert(issues).values([
      { id: agentMoved, companyId, title: "Loose task", status: "todo", assigneeAgentId: agentId },
      { id: boardMoved, companyId, title: "Board loose task", status: "todo", assigneeAgentId: agentId },
    ]);

    const byAgent = await request(app(agentActor(runOnChild)))
      .patch(`/api/issues/${agentMoved}`)
      .send({ parentId: childId });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(200);
    expect(byAgent.body.parentId).toBe(rootId);
    expect(byAgent.body.parentAdjusted).toEqual(expectedAdjustment);
    expect((await activity(agentMoved, "issue.updated"))?.details).toMatchObject({
      parentId: rootId,
      requestedParentId: childId,
      parentAdjusted: expectedAdjustment,
    });

    const byBoard = await request(app(boardActor))
      .patch(`/api/issues/${boardMoved}`)
      .send({ parentId: childId });
    expect(byBoard.status, JSON.stringify(byBoard.body)).toBe(200);
    expect(byBoard.body.parentId).toBe(childId);
    expect(byBoard.body).not.toHaveProperty("parentAdjusted");
  });

  it("records a top-level placement when an agent moves under a legacy conversation child", async () => {
    const movingId = randomUUID();
    await db.insert(issues).values({ id: movingId, companyId, parentId: rootId, title: "Move to top", status: "todo", assigneeAgentId: agentId });

    const moved = await request(app(agentActor(runOnChild)))
      .patch(`/api/issues/${movingId}`)
      .send({ parentId: legacyConversationChildId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.parentId).toBeNull();
    expect(moved.body.parentAdjusted).toMatchObject({ reason: "max_agent_depth", effectiveParent: null });
    expect((await activity(movingId, "issue.updated"))?.details).toMatchObject({
      parentId: null,
      requestedParentId: legacyConversationChildId,
    });
  });

  it("lets a chat create a top-level task and a child under it", async () => {
    const top = await request(app(agentActor(runOnConversation)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Plan the launch", assigneeAgentId: agentId });
    expect(top.status, JSON.stringify(top.body)).toBe(201);
    expect(top.body.parentId).toBeNull();
    expect(top.body.originIssueId).toBe(conversationId);

    const child = await request(app(agentActor(runOnConversation)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Draft the announcement", parentId: top.body.id, assigneeAgentId: agentId });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.parentId).toBe(top.body.id);
    expect(child.body.originIssueId).toBe(top.body.id);
    expect(child.body).not.toHaveProperty("parentAdjusted");
  });
});
