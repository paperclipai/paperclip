import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, projects as projectsTable } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { PROJECT_TREE_ERROR_CODES } from "../services/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("project tree HTTP wire contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let counter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-tree-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function createCompany() {
    counter += 1;
    return db
      .insert(companies)
      .values({ name: `Tree Routes Co ${counter}`, issuePrefix: `WR${counter}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  function createApp(companyId: string) {
    const app = express();
    app.locals.paperclipDb = db;
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "project-tree-route-test",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createProject(app: express.Express, companyId: string, body: Record<string, unknown>) {
    const response = await request(app).post(`/api/companies/${companyId}/projects`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { id: string; parentProjectId: string | null };
  }

  function expectTreeConflict(
    response: request.Response,
    code: (typeof PROJECT_TREE_ERROR_CODES)[keyof typeof PROJECT_TREE_ERROR_CODES],
  ) {
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body).toMatchObject({ code, details: { code } });
  }

  it("exposes parentProjectId on list, create, update, and detail responses", async () => {
    const company = await createCompany();
    const app = createApp(company.id);
    const root = await createProject(app, company.id, { name: "Root" });
    const child = await createProject(app, company.id, {
      name: "Child",
      parentProjectId: root.id,
    });

    expect(root.parentProjectId).toBeNull();
    expect(child.parentProjectId).toBe(root.id);

    const listResponse = await request(app).get(`/api/companies/${company.id}/projects`);
    expect(listResponse.status, JSON.stringify(listResponse.body)).toBe(200);
    expect(listResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: root.id, parentProjectId: null }),
        expect.objectContaining({ id: child.id, parentProjectId: root.id }),
      ]),
    );

    const updateResponse = await request(app)
      .patch(`/api/projects/${child.id}`)
      .send({ parentProjectId: null });
    expect(updateResponse.status, JSON.stringify(updateResponse.body)).toBe(200);
    expect(updateResponse.body).toMatchObject({ id: child.id, parentProjectId: null });

    const detailResponse = await request(app).get(`/api/projects/${child.id}`);
    expect(detailResponse.status, JSON.stringify(detailResponse.body)).toBe(200);
    expect(detailResponse.body).toMatchObject({ id: child.id, parentProjectId: null });
  });

  it("returns stable PROJECT_TREE codes for depth and invalid-parent conflicts", async () => {
    const company = await createCompany();
    const app = createApp(company.id);
    const root = await createProject(app, company.id, { name: "Root" });
    const level2 = await createProject(app, company.id, {
      name: "Level 2",
      parentProjectId: root.id,
    });
    const level3 = await createProject(app, company.id, {
      name: "Level 3",
      parentProjectId: level2.id,
    });

    const depthResponse = await request(app)
      .post(`/api/companies/${company.id}/projects`)
      .send({ name: "Level 4", parentProjectId: level3.id });
    expectTreeConflict(depthResponse, PROJECT_TREE_ERROR_CODES.depthExceeded);

    const missingParentResponse = await request(app)
      .post(`/api/companies/${company.id}/projects`)
      .send({
        name: "Missing parent",
        parentProjectId: "11111111-1111-4111-8111-111111111111",
      });
    expectTreeConflict(missingParentResponse, PROJECT_TREE_ERROR_CODES.parentNotFound);
  });
});
