import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  issues,
  projects,
  responsibilities,
  responsibilityAreas,
  responsibilityLinks,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { responsibilitySummaryRoutes } from "../routes/responsibility-summaries.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  createResponsibilitySummaryStore,
  waitForResponsibilitySummaryGenerations,
  type ResponsibilitySummaryGenerationRequest,
  type ResponsibilitySummaryGenerator,
} from "../services/responsibility-summaries.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_SUMMARIES_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";
const METRIC = { standard: "Every investor conversation has a next step", metricName: "Investors contacted", metricTarget: 20 };

function localBoardActor(): Actor {
  return { type: "board", userId: OWNER, source: "local_implicit", isInstanceAdmin: true };
}

function sessionBoardActor(companyId: string, userId: string): Actor {
  return {
    type: "board", userId, source: "session", sessionId: `session-${userId}`, companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }], isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Actor {
  return { type: "agent", companyId, agentId, source: "agent_jwt" };
}

function fakeModel(available = true) {
  const calls: ResponsibilitySummaryGenerationRequest[] = [];
  const generator: ResponsibilitySummaryGenerator = {
    availability: vi.fn(async () => available),
    generate: vi.fn(async (input: ResponsibilitySummaryGenerationRequest) => {
      calls.push(input);
      return { status: "succeeded" as const, text: `Model text for ${input.feature}.` };
    }),
  };
  return { generator, calls };
}

describeEmbeddedPostgres("responsibility summary routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-summaries-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterEach(async () => {
    await db.delete(responsibilityLinks);
    await db.delete(responsibilities);
    await db.delete(responsibilityAreas);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function createApp(actor: Actor, model = fakeModel()) {
    const store = createResponsibilitySummaryStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", responsibilityRoutes(db, { heartbeat: { wakeup: async () => ({ queued: true }) } }));
    app.use("/api", responsibilitySummaryRoutes(db, { summaries: { generator: model.generator, store } }));
    app.use(errorHandler);
    return { app, store, model };
  }

  async function seedCompany(name = "Summaries Co") {
    const company = await db.insert(companies)
      .values({ name, issuePrefix: `S${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner",
    });
    return company;
  }

  async function enable() {
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  }

  it("returns not found on both routes while the flag is off", async () => {
    const company = await seedCompany();
    const { app, model } = createApp(localBoardActor());
    for (const res of [
      await request(app).get(`/api/companies/${company.id}/responsibilities/summary`),
      await request(app).get(`/api/responsibilities/${randomUUID()}/summary`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Responsibilities are not enabled");
    }
    expect(model.generator.availability).not.toHaveBeenCalled();
  });

  it("answers at once with the computed paragraph, then the model's, for the dashboard and a responsibility", async () => {
    await enable();
    const company = await seedCompany();
    const { app, store, model } = createApp(localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Fundraising", ...METRIC, metricCurrent: 4 });
    expect(created.status).toBe(201);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Pipeline" }).returning().then((rows) => rows[0]!);
    await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Legal review", status: "blocked", priority: "medium" });
    expect((await request(app).post(`/api/responsibilities/${created.body.id}/links`).send({ projectId: project.id })).status).toBe(201);

    const dashboard = await request(app).get(`/api/companies/${company.id}/responsibilities/summary`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({ source: "computed", refreshing: true });
    expect(dashboard.body.text).toBe("Fundraising, your one active responsibility, is behind: the task \u201cLegal review\u201d is blocked.");
    expect(new Date(dashboard.body.generatedAt).toString()).not.toBe("Invalid Date");

    const page = await request(app).get(`/api/responsibilities/${created.body.id}/summary`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ source: "computed", refreshing: true });
    expect(page.body.text).toBe("This responsibility is behind: it is at 20% of target. The task \u201cLegal review\u201d is blocked and unassigned.");

    await waitForResponsibilitySummaryGenerations(store);
    expect((await request(app).get(`/api/companies/${company.id}/responsibilities/summary`)).body)
      .toMatchObject({ text: "Model text for responsibilities.where_things_stand.", source: "model", refreshing: false });
    expect((await request(app).get(`/api/responsibilities/${created.body.id}/summary`)).body)
      .toMatchObject({ text: "Model text for responsibilities.what_is_affecting_the_number.", source: "model", refreshing: false });
    expect(model.generator.generate).toHaveBeenCalledTimes(2);
    const prompt = model.calls.find((call) => call.feature === "responsibilities.what_is_affecting_the_number")!.prompt;
    expect(prompt).toContain("Legal review");
    expect(prompt).not.toContain(project.id);
    // Reads log nothing.
    const actions = await db.select({ action: activityLog.action }).from(activityLog);
    expect(actions.map((row) => row.action).filter((action) => action.includes("summary"))).toEqual([]);
  });

  it("keeps the computed paragraph and never refreshes without a usable model", async () => {
    await enable();
    const company = await seedCompany();
    const { app, model } = createApp(localBoardActor(), fakeModel(false));
    await request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title: "Fundraising", ...METRIC });
    const res = await request(app).get(`/api/companies/${company.id}/responsibilities/summary`);
    expect(res.body).toMatchObject({ source: "computed", refreshing: false });
    expect(res.body.text.length).toBeGreaterThan(0);
    expect(model.generator.generate).not.toHaveBeenCalled();
  });

  it("applies the overview and detail access rules", async () => {
    await enable();
    const company = await seedCompany();
    const other = await seedCompany("Other Co");
    const { app } = createApp(localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title: "Fundraising", ...METRIC });

    const outsider = createApp(sessionBoardActor(other.id, "outsider")).app;
    expect((await request(outsider).get(`/api/companies/${company.id}/responsibilities/summary`)).status).toBe(403);
    expect((await request(outsider).get(`/api/responsibilities/${created.body.id}/summary`)).status).toBe(404);
    expect((await request(app).get(`/api/responsibilities/${randomUUID()}/summary`)).status).toBe(404);

    const agent = await db.insert(agents).values({
      companyId: company.id, name: "Guide", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const agentApp = createApp(agentActor(company.id, agent.id)).app;
    const missingOwner = await request(agentApp).get(`/api/companies/${company.id}/responsibilities/summary`);
    expect(missingOwner.status).toBe(403);
    expect((await request(agentApp).get(`/api/companies/${company.id}/responsibilities/summary?ownerUserId=${OWNER}`)).status).toBe(403);
    expect((await request(agentApp).get(`/api/responsibilities/${created.body.id}/summary`)).status).toBe(403);
  });
});
