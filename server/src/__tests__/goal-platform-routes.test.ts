import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  goalRelations,
  goalTargets,
  goals,
  principalPermissionGrants,
  roadmapBlockEdges,
  roadmapBlockLinks,
  roadmapBlocks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { goalPlatformRoutes } from "../routes/goal-platform.js";
import { goalRoutes } from "../routes/goals.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal platform route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goal platform routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-platform-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(goalRelations);
    await db.delete(goalTargets);
    await db.delete(roadmapBlockEdges);
    await db.delete(roadmapBlockLinks);
    await db.delete(roadmapBlocks);
    await db.delete(goals);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: { type: "agent"; agentId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (actor?.type === "agent") {
        (req as any).actor = {
          type: "agent",
          agentId: actor.agentId,
          companyId,
          source: "agent_key",
        };
      } else {
        (req as any).actor = {
          type: "board",
          userId: "cloud-user-1",
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" }],
          source: "cloud_tenant",
          isInstanceAdmin: false,
        };
      }
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use("/api", goalPlatformRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
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

  it("targets: create, nest, check, reorder, relations, and serve links", async () => {
    const { companyId } = await seedCompany();
    const app = createApp(companyId);

    const goalRes = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Trading output", level: "objective", status: "active" });
    expect(goalRes.status).toBe(201);
    const goalId = goalRes.body.id;

    const initiativeRes = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Strategy discovery", level: "initiative", status: "active" });
    expect(initiativeRes.status).toBe(201);

    const target = await request(app)
      .post(`/api/goals/${goalId}/targets`)
      .send({ text: "Deploy 100 live strategies" });
    expect(target.status).toBe(201);

    const sub = await request(app)
      .post(`/api/goals/${goalId}/targets`)
      .send({ text: "Backlog of ideas", parentId: target.body.id });
    expect(sub.status).toBe(201);
    expect(sub.body.parentId).toBe(target.body.id);

    const checked = await request(app)
      .patch(`/api/goal-targets/${target.body.id}`)
      .send({ checked: true, sortOrder: 3 });
    expect(checked.body.checked).toBe(true);
    expect(checked.body.sortOrder).toBe(3);

    const relation = await request(app)
      .post(`/api/companies/${companyId}/goal-relations`)
      .send({ type: "serves", fromGoalId: initiativeRes.body.id, toTargetId: target.body.id });
    expect(relation.status).toBe(201);

    const list = await request(app).get(`/api/companies/${companyId}/goal-relations`);
    expect(list.body).toHaveLength(1);

    // Serve links surface on the goal map node.
    const map = await request(app).get(`/api/companies/${companyId}/goal-map`);
    const initiativeNode = map.body.nodes.find((n: any) => n.goal.id === initiativeRes.body.id);
    expect(initiativeNode.serves).toHaveLength(1);
    expect(initiativeNode.serves[0].targetText).toBe("Deploy 100 live strategies");
  });

  it("roadmap: blocks, edges, and promote-to-epic", async () => {
    const { companyId } = await seedCompany();
    const app = createApp(companyId);

    const initiative = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Strategy discovery", level: "initiative", status: "active" });

    const blockA = await request(app)
      .post(`/api/companies/${companyId}/roadmap-blocks`)
      .send({ title: "Option Data", detail: "collect option data", x: 10, y: 20 });
    expect(blockA.status).toBe(201);
    const blockB = await request(app)
      .post(`/api/companies/${companyId}/roadmap-blocks`)
      .send({ title: "Option Strategy", x: 300, y: 20, status: "planned" });

    const edge = await request(app)
      .post(`/api/companies/${companyId}/roadmap-block-edges`)
      .send({ fromBlockId: blockA.body.id, toBlockId: blockB.body.id });
    expect(edge.status).toBe(201);

    const moved = await request(app)
      .patch(`/api/roadmap-blocks/${blockA.body.id}`)
      .send({ x: 55, y: 66 });
    expect(moved.body.x).toBe(55);

    const promoted = await request(app)
      .post(`/api/roadmap-blocks/${blockB.body.id}/promote`)
      .send({ level: "epic", parentGoalId: initiative.body.id });
    expect(promoted.status).toBe(201);
    expect(promoted.body.goal.level).toBe("epic");
    expect(promoted.body.goal.parentId).toBe(initiative.body.id);
    expect(promoted.body.link.blockId).toBe(blockB.body.id);
    expect(promoted.body.link.goalId).toBe(promoted.body.goal.id);

    // A block can link several goals at once; linking is idempotent.
    const secondLink = await request(app)
      .post(`/api/companies/${companyId}/roadmap-block-links`)
      .send({ blockId: blockB.body.id, goalId: initiative.body.id });
    expect(secondLink.status).toBe(201);
    const duplicateLink = await request(app)
      .post(`/api/companies/${companyId}/roadmap-block-links`)
      .send({ blockId: blockB.body.id, goalId: initiative.body.id });
    expect(duplicateLink.body.id).toBe(secondLink.body.id);

    const board = await request(app).get(`/api/companies/${companyId}/roadmap`);
    expect(board.body.blocks).toHaveLength(2);
    expect(board.body.edges).toHaveLength(1);
    expect(board.body.links).toHaveLength(2);

    const unlinked = await request(app).delete(`/api/roadmap-block-links/${secondLink.body.id}`);
    expect(unlinked.status).toBe(200);
    const afterUnlink = await request(app).get(`/api/companies/${companyId}/roadmap`);
    expect(afterUnlink.body.links).toHaveLength(1);
  });

  it("agents cannot touch the human planning layer", async () => {
    const { companyId } = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Alpha Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const humanApp = createApp(companyId);
    const agentApp = createApp(companyId, { type: "agent", agentId });

    // Agent may still create task-level goals.
    const taskGoal = await request(agentApp)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "agent scratch goal", level: "task" });
    expect(taskGoal.status).toBe(201);

    const initiative = await request(agentApp)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "sneaky initiative", level: "initiative" });
    expect(initiative.status).toBe(403);

    const objective = await request(humanApp)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Real objective", level: "objective" });
    expect(objective.status).toBe(201);

    const agentEdit = await request(agentApp)
      .patch(`/api/goals/${objective.body.id}`)
      .send({ title: "renamed by agent" });
    expect(agentEdit.status).toBe(403);

    const agentTarget = await request(agentApp)
      .post(`/api/goals/${objective.body.id}/targets`)
      .send({ text: "agent target" });
    expect(agentTarget.status).toBe(403);

    const agentBlock = await request(agentApp)
      .post(`/api/companies/${companyId}/roadmap-blocks`)
      .send({ title: "agent block", x: 0, y: 0 });
    expect(agentBlock.status).toBe(403);

    // Reads stay open to agents.
    const read = await request(agentApp).get(`/api/companies/${companyId}/roadmap`);
    expect(read.status).toBe(200);
  });
});
