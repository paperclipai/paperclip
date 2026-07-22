import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  statusCards,
  statusCardUpdates,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function localBoardActor(): Express.Request["actor"] {
  return { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
}

function unprivilegedBoardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "unprivileged-user",
    source: "session",
    sessionId: "session-1",
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", statusCardRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("status card routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-cards-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(statusCardUpdates);
    await db.delete(statusCards);
    await db.delete(activityLog);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    return db
      .insert(companies)
      .values({ name: "Status Cards Co", issuePrefix: `SC${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function enableStatusCards() {
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
  }

  it("returns 404 while the experimental flag is disabled", async () => {
    const company = await seedCompany();
    const response = await request(createApp(db, localBoardActor())).get(`/api/companies/${company.id}/status-cards`);
    expect(response.status).toBe(404);
    expect(response.body.error).toContain("not enabled");
  });

  it("creates, patches, archives, restores, lists updates, and deletes a card", async () => {
    const company = await seedCompany();
    await enableStatusCards();
    const app = createApp(db, localBoardActor());

    const created = await request(app)
      .post(`/api/companies/${company.id}/status-cards`)
      .send({ interestPrompt: "Recently updated launch tasks" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      companyId: company.id,
      createdByUserId: "board-user",
      interestPrompt: "Recently updated launch tasks",
      state: "compiling",
      queries: [],
      refreshPolicy: { mode: "manual" },
    });

    const patched = await request(app)
      .patch(`/api/status-cards/${created.body.id}`)
      .send({ title: "Launch health", titlePinned: true, instructionsMode: "append", instructions: "Call out blockers." });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "Launch health", titlePinned: true, instructionsMode: "append" });

    const archived = await request(app).patch(`/api/status-cards/${created.body.id}`).send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBeTruthy();
    expect((await request(app).get(`/api/companies/${company.id}/status-cards`)).body).toEqual([]);
    expect((await request(app).get(`/api/companies/${company.id}/status-cards?archived=true`)).body).toHaveLength(1);

    const restored = await request(app).patch(`/api/status-cards/${created.body.id}`).send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archivedAt).toBeNull();
    expect((await request(app).get(`/api/companies/${company.id}/status-cards`)).body).toHaveLength(1);

    const updates = await request(app).get(`/api/status-cards/${created.body.id}/updates`);
    expect(updates.status).toBe(200);
    expect(updates.body).toEqual([]);

    expect((await request(app).delete(`/api/status-cards/${created.body.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/status-cards/${created.body.id}`)).status).toBe(404);
  });

  it("requires tasks:assign for mutations", async () => {
    const company = await seedCompany();
    await enableStatusCards();
    const response = await request(createApp(db, unprivilegedBoardActor(company.id)))
      .post(`/api/companies/${company.id}/status-cards`)
      .send({ interestPrompt: "Protected mutation" });
    expect(response.status).toBe(403);
  });

  it("attributes API-level authoring to an active company agent", async () => {
    const company = await seedCompany();
    await enableStatusCards();
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Status Card Author",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const app = createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: null,
      source: "agent_jwt",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/status-cards`)
      .send({ interestPrompt: "Tasks I should monitor" });

    expect(response.status).toBe(201);
    expect(response.body.createdByAgentId).toBe(agent.id);
    expect(response.body.createdByUserId).toBeNull();
  });
});
