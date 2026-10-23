import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, goals, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { goalRoutes } from "../routes/goals.js";
import { projectRoutes } from "../routes/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal and project malformed id tests on this host: ${
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
  app.use("/api", goalRoutes(db));
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("goal and project routes with a malformed id", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-project-malformed-id-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "company", status: "active" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    return { companyId, goalId, projectId };
  }

  it("returns 404 for a goal id that is not a UUID", async () => {
    const { companyId, goalId } = await seed();
    const app = createApp(db, boardActor(companyId));

    for (const ref of ["not-a-uuid", goalId.slice(0, 8)]) {
      const read = await request(app).get(`/api/goals/${ref}`);
      expect(read.status).toBe(404);
      expect(read.body).toEqual({ error: "Goal not found" });
      expect((await request(app).patch(`/api/goals/${ref}`).send({ title: "Renamed" })).status).toBe(404);
      expect((await request(app).delete(`/api/goals/${ref}`)).status).toBe(404);
    }

    expect((await request(app).get(`/api/goals/${randomUUID()}`)).status).toBe(404);
    const found = await request(app).get(`/api/goals/${goalId.toUpperCase()}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(goalId);
  });

  it("returns 404 for a project id that is not a UUID", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    for (const ref of ["not-a-uuid", projectId.slice(0, 8)]) {
      const read = await request(app).get(`/api/projects/${ref}`);
      expect(read.status).toBe(404);
      expect(read.body).toEqual({ error: "Project not found" });
      expect((await request(app).get(`/api/projects/${ref}`).query({ companyId })).status).toBe(404);
    }

    expect((await request(app).get(`/api/projects/${randomUUID()}`)).status).toBe(404);
    const found = await request(app).get(`/api/projects/${projectId}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(projectId);
  });
});
