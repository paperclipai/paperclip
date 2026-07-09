import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMemberships,
  agents,
  companies,
  createDb,
  projectMemberships,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resourceMembershipRoutes } from "../routes/resource-memberships.js";
import { errorHandler } from "../middleware/index.js";
import { resourceMembershipService } from "../services/resource-memberships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource membership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function boardActor(companyId: string, role: "admin" | "operator" | "viewer" = "viewer") {
  return {
    type: "board" as const,
    userId: "user-1",
    source: "session" as const,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", resourceMembershipRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("resource membership routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-memberships-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectMemberships);
    await db.delete(agentMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const archivedProjectId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Growth", status: "in_progress" },
      { id: archivedProjectId, companyId, name: "Archived", status: "completed", archivedAt: new Date() },
      { id: otherProjectId, companyId: otherCompanyId, name: "Other", status: "in_progress" },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { archivedProjectId, companyId, otherAgentId, otherProjectId, projectId, agentId, terminatedAgentId };
  }

  it("defaults missing membership rows to joined", async () => {
    const { companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: null,
    });
  });

  it("allows viewer self-service mutations, logs changes, and keeps repeats idempotent", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId, "viewer"));

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "left", starredAt: null });
    expect(second.status).toBe(200);

    const rows = await db.select().from(projectMemberships);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, projectId, userId: "user-1", state: "left" });

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "resource_membership.left",
      entityType: "project",
      entityId: projectId,
    });
  });

  it("stars projects idempotently and exposes starred project contract data", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId, "viewer"));

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "joined" });
    expect(first.body.starredAt).toEqual(expect.any(String));
    expect(second.status).toBe(200);
    expect(second.body.starredAt).toBe(first.body.starredAt);
    expect(list.body.starredProjectIds).toEqual([projectId]);
    expect(list.body.projectStarredAt[projectId]).toEqual(first.body.starredAt);

    const rows = await db.select().from(projectMemberships);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, projectId, userId: "user-1", state: "joined" });
    expect(rows[0]?.starredAt).toBeInstanceOf(Date);

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "resource_membership.starred",
      entityType: "project",
      entityId: projectId,
    });
    expect(activity[0]?.details).toMatchObject({
      userId: "user-1",
      resourceType: "project",
      resourceId: projectId,
      state: "joined",
      starred: true,
    });
  });

  it("clears starred_at when leaving a starred resource", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true })
      .expect(200);
    const leave = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });

    expect(leave.status).toBe(200);
    expect(leave.body).toMatchObject({ state: "left", starredAt: null });
    const [row] = await db.select().from(projectMemberships);
    expect(row).toMatchObject({ state: "left", starredAt: null });

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.starred",
      "resource_membership.left",
    ]);
    expect(activity[1]?.details).toMatchObject({ state: "left", starred: false, starredAt: null });
  });

  it("starring a left resource rejoins it", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ state: "left" })
      .expect(200);
    const star = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: true });

    expect(star.status).toBe(200);
    expect(star.body).toMatchObject({ resourceType: "agent", resourceId: agentId, state: "joined" });
    expect(star.body.starredAt).toEqual(expect.any(String));

    const [row] = await db.select().from(agentMemberships);
    expect(row).toMatchObject({ state: "joined" });
    expect(row?.starredAt).toBeInstanceOf(Date);

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.left",
      "resource_membership.starred",
    ]);
  });

  it("unstars agents idempotently without requiring a state change", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: true })
      .expect(200);
    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: false });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: false });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "joined", starredAt: null });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ state: "joined", starredAt: null });

    const [row] = await db.select().from(agentMemberships);
    expect(row).toMatchObject({ state: "joined", starredAt: null });

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.starred",
      "resource_membership.unstarred",
    ]);
  });

  it("omits archived projects and terminated agents from starred sidebar data", async () => {
    const { archivedProjectId, companyId, terminatedAgentId } = await seed();
    const starredAt = new Date();
    await db.insert(projectMemberships).values({
      companyId,
      projectId: archivedProjectId,
      userId: "user-1",
      state: "joined",
      starredAt,
    });
    await db.insert(agentMemberships).values({
      companyId,
      agentId: terminatedAgentId,
      userId: "user-1",
      state: "joined",
      starredAt,
    });
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body.projectMemberships[archivedProjectId]).toBe("joined");
    expect(res.body.agentMemberships[terminatedAgentId]).toBe("joined");
    expect(res.body.starredProjectIds).toEqual([]);
    expect(res.body.starredAgentIds).toEqual([]);
    expect(res.body.projectStarredAt).toEqual({});
    expect(res.body.agentStarredAt).toEqual({});
  });

  it("rejects starring archived projects and terminated agents", async () => {
    const { archivedProjectId, companyId, terminatedAgentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${archivedProjectId}`)
      .send({ starred: true });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${terminatedAgentId}`)
      .send({ starred: true });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
  });

  it("rejects agent API key actors", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(403);
  });

  it("rejects cross-company target resources", async () => {
    const { companyId, otherAgentId, otherProjectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${otherProjectId}`)
      .send({ state: "left" });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${otherAgentId}`)
      .send({ state: "left" });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
    await expect(db.select().from(projectMemberships)).resolves.toHaveLength(0);
    await expect(db.select().from(agentMemberships)).resolves.toHaveLength(0);
  });

  it("denies direct service calls that try to mutate another user's membership", async () => {
    const { companyId, projectId } = await seed();
    const svc = resourceMembershipService(db);

    await expect(
      svc.updateProject({
        companyId,
        projectId,
        userId: "other-user",
        state: "left",
        actor: boardActor(companyId),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
