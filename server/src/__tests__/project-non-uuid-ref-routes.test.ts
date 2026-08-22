import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects } from "@paperclipai/db";
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
    `Skipping embedded Postgres project non-UUID ref tests on this host: ${
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

describeEmbeddedPostgres("project route refs that are not UUIDs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-non-uuid-ref-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Demo Project",
      status: "in_progress",
    });

    return { companyId, projectId };
  }

  it("resolves a project shortname when the company scope is known", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/projects/demo-project?companyId=${companyId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(projectId);
  });

  it("keeps returning the project for a UUID ref", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/projects/${projectId}?companyId=${companyId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(projectId);
  });

  it("returns 404 for a ref that matches no shortname", async () => {
    const { companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/projects/not-a-project?companyId=${companyId}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a shortname that has no company scope", async () => {
    const { companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get("/api/projects/demo-project");

    expect(res.status).toBe(404);
  });
});
