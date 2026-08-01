import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, projectAccessMembers, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project list archived tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("project list archived route defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projects-list-archived-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const activeProjectId = randomUUID();
    const archivedProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values([
      { id: activeProjectId, companyId, name: "Active Project", status: "in_progress" },
      {
        id: archivedProjectId,
        companyId,
        name: "Archived Project",
        status: "completed",
        archivedAt: new Date(),
      },
    ]);

    return { activeProjectId, archivedProjectId, companyId };
  }

  it("omits archived projects by default", async () => {
    const { activeProjectId, archivedProjectId, companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/projects`);

    expect(res.status).toBe(200);
    expect(res.body.map((project: { id: string }) => project.id)).toEqual([activeProjectId]);
    expect(res.body.map((project: { id: string }) => project.id)).not.toContain(archivedProjectId);
  });

  it("includes archived projects when includeArchived is true", async () => {
    const { activeProjectId, archivedProjectId, companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/projects?includeArchived=true`);

    expect(res.status).toBe(200);
    expect(res.body.map((project: { id: string }) => project.id)).toEqual([activeProjectId, archivedProjectId]);
  });
});

describeEmbeddedPostgres.sequential("private project route visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-private-project-routes-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  it("omits private projects from non-member lists and returns 404 on direct fetch", async () => {
    const companyId = randomUUID();
    const privateProjectId = randomUUID();
    const memberUserId = "project-member";
    await db.insert(companies).values({
      id: companyId,
      name: "Private projects",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(projects).values([
      { companyId, name: "Open project", visibility: "open" },
      { id: privateProjectId, companyId, name: "Secret project", visibility: "private" },
    ]);
    await db.insert(companyMemberships).values([memberUserId, "project-outsider"].map((principalId) => ({
      companyId,
      principalType: "user" as const,
      principalId,
      status: "active",
      membershipRole: "admin",
    })));
    await db.insert(projectAccessMembers).values({
      companyId,
      projectId: privateProjectId,
      subjectType: "user",
      subjectId: memberUserId,
    });
    const actorFor = (userId: string): Express.Request["actor"] => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    });

    const outsiderApp = createApp(db, actorFor("project-outsider"));
    const outsiderList = await request(outsiderApp).get(`/api/companies/${companyId}/projects`);
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.map((project: { id: string }) => project.id)).not.toContain(privateProjectId);
    await request(outsiderApp).get(`/api/projects/${privateProjectId}`).expect(404);

    const memberApp = createApp(db, actorFor(memberUserId));
    const memberList = await request(memberApp).get(`/api/companies/${companyId}/projects`);
    expect(memberList.body.map((project: { id: string }) => project.id)).toContain(privateProjectId);
    await request(memberApp).get(`/api/projects/${privateProjectId}`).expect(200);
  });
});
