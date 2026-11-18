import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  documents,
  instanceSettings,
  issueDocuments,
  issueReferenceMentions,
  issues,
  projects,
  responsibilities,
  responsibilityAreas,
  responsibilityLinks,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { responsibilityAreaRoutes } from "../routes/responsibility-areas.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITIES_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";
const DAY = 86_400_000;
const METRIC = { standard: "Every investor conversation has a next step", metricName: "Investors contacted", metricTarget: 20 };

function localBoardActor(): Actor {
  return { type: "board", userId: OWNER, source: "local_implicit", isInstanceAdmin: true };
}

function sessionBoardActor(companyId: string, userId: string, role = "operator"): Actor {
  return {
    type: "board",
    userId,
    source: "session",
    sessionId: `session-${userId}`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
    isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Actor {
  return { type: "agent", companyId, agentId, source: "agent_jwt" };
}

function createApp(db: Db, actor: Actor, heartbeat: IssueAssignmentWakeupDeps = { wakeup: async () => ({ queued: true }) }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", responsibilityRoutes(db, { heartbeat }));
  app.use("/api", responsibilityAreaRoutes(db));
  app.use(errorHandler);
  return app;
}

function isoDaysFromNow(days: number) {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

describeEmbeddedPostgres("responsibility routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibilities-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterEach(async () => {
    await db.delete(responsibilityLinks);
    await db.delete(responsibilities);
    await db.delete(responsibilityAreas);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueReferenceMentions);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Responsibilities Co") {
    const company = await db.insert(companies)
      .values({ name, issuePrefix: `R${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: "other-user", status: "active", membershipRole: "operator" },
    ]);
    return company;
  }

  async function seedAgent(companyId: string, name = "Guide", desiredSkills: string[] = []) {
    return db.insert(agents).values({
      companyId,
      name,
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4", ...(desiredSkills.length > 0 ? { paperclipSkillSync: { desiredSkills } } : {}) },
    }).returning().then((rows) => rows[0]!);
  }

  async function enable() {
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  }

  type Created = { id: string; status: string; confirmedAt: string | null; ownerUserId: string; areaId: string | null; runByAgentId: string | null };

  async function createResponsibility(app: express.Express, companyId: string, body: Record<string, unknown> = {}) {
    const res = await request(app).post(`/api/companies/${companyId}/responsibilities`).send({ title: "Fundraising", ...METRIC, ...body });
    expect(res.status).toBe(201);
    return res.body as Created;
  }

  async function actions(companyId: string) {
    return db.select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.companyId, companyId));
  }

  it("returns not found on every route while the flag is off", async () => {
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const list = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    expect(list.status).toBe(404);
    expect(list.body.error).toContain("not enabled");
    for (const res of [
      await request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title: "x", ...METRIC }),
      await request(app).get(`/api/responsibilities/${randomUUID()}`),
      await request(app).post(`/api/responsibilities/${randomUUID()}/links`).send({ projectId: randomUUID() }),
      await request(app).get(`/api/companies/${company.id}/responsibility-links/lookup?projectId=${randomUUID()}`),
      await request(app).get(`/api/companies/${company.id}/responsibility-areas`),
      await request(app).post(`/api/companies/${company.id}/responsibility-areas`).send({ title: "Fundraising" }),
      await request(app).patch(`/api/responsibility-areas/${randomUUID()}`).send({ title: "x" }),
      await request(app).delete(`/api/responsibility-areas/${randomUUID()}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Responsibilities are not enabled");
    }
  });

  it("refuses a half-filled bar, and derives status from the metric", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    // Any metric input makes the whole bar required: the sentence, what is measured and the target.
    expect((await request(app).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "x", standard: "Bar", metricName: "Calls" })).status).toBe(400);
    const targetOnly = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title: "x", metricTarget: 20 });
    expect(targetOnly.status).toBe(400);
    expect(JSON.stringify(targetOnly.body)).toContain("needs its bar as a sentence (standard)");
    expect(JSON.stringify(targetOnly.body)).toContain("needs what is measured (metricName)");
    expect((await request(app).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "x", metricKind: "range", metricLow: 1 })).status).toBe(400);

    const onTrack = await createResponsibility(app, company.id, { title: "Customers", metricName: "Accounts checked in", metricTarget: 5, metricCurrent: 5 });
    const atRisk = await createResponsibility(app, company.id, { title: "Fundraising", metricCurrent: 15 });
    const behind = await createResponsibility(app, company.id, {
      title: "Hiring", metricName: "Reply time", metricUnit: "days", metricTarget: 2, metricCurrent: 4, metricDirection: "at_most",
    });
    const unmeasured = await createResponsibility(app, company.id, { title: "Product" });
    expect(onTrack).toMatchObject({ status: "active", ownerUserId: OWNER });
    expect(onTrack.confirmedAt).not.toBeNull();

    const overview = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    expect(overview.status).toBe(200);
    const byId = new Map(overview.body.responsibilities.map((row: { id: string }) => [row.id, row]));
    const rollup = (id: string) => (byId.get(id) as { rollup: Record<string, unknown> }).rollup;
    expect(rollup(onTrack.id)).toMatchObject({ health: "on_track", statusSentence: "5 of 5 accounts checked in, 100% of target" });
    expect(rollup(atRisk.id)).toMatchObject({ health: "at_risk", statusSentence: "15 of 20 investors contacted, 75% of target" });
    expect(rollup(atRisk.id).metric).toMatchObject({ name: "Investors contacted", target: 20, current: 15, direction: "at_least", attainment: 0.75, stale: false });
    expect(rollup(behind.id)).toMatchObject({ health: "behind", statusSentence: "Reply time: 4 days against a target of at most 2 days" });
    expect(rollup(unmeasured.id)).toMatchObject({
      health: "not_measured",
      statusSentence: "Not measured yet: no reading of investors contacted against a target of 20",
    });
    expect(overview.body.totals.byHealth).toEqual({ behind: 1, at_risk: 1, on_track: 1, not_measured: 1 });

    const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, atRisk.id));
    expect(row?.metricUpdatedAt).not.toBeNull();
    const logged = await actions(company.id);
    expect(logged.filter((entry) => entry.action === "responsibility.created")).toHaveLength(4);
  });

  it("lets a person create and confirm a responsibility with no bar, which reads as not measured", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Every screen is built from tokens, with no one-off colors, sizes, or shadows." });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "active",
      standard: null,
      metricName: null,
      metricTarget: null,
      metricDirection: null,
      metricCurrent: null,
      rollup: { health: "not_measured", metric: null, statusSentence: "Not measured: no metric is set" },
    });
    expect(created.body.confirmedAt).not.toBeNull();
    // Stored with no template at all (the API reads that as a volume, like rows from before templates).
    const [stored] = await db.select().from(responsibilities).where(eq(responsibilities.id, created.body.id));
    expect(stored).toMatchObject({ metricKind: null, metricName: null, metricUnit: null, metricDirection: null });
    // A sentence alone is a bar with no metric yet.
    const sentenceOnly = await request(app).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Tokens", standard: "Every screen is built from tokens." });
    expect(sentenceOnly.status).toBe(201);
    expect(sentenceOnly.body).toMatchObject({ standard: "Every screen is built from tokens.", metricName: null, rollup: { health: "not_measured" } });
    // Still active after an unrelated edit.
    const renamed = await request(app).patch(`/api/responsibilities/${created.body.id}`).send({ title: "Token coverage", status: "active" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ status: "active", rollup: { health: "not_measured" } });

    const overview = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    expect(overview.body.totals.byHealth).toEqual({ behind: 0, at_risk: 0, on_track: 0, not_measured: 2 });
    expect((await actions(company.id)).filter((entry) => entry.action === "responsibility.created")).toHaveLength(2);
  });

  it("lets a person confirm a proposal with no bar, and refuses one whose metric is half-filled", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    // A row from before metrics existed.
    const [legacy] = await db.insert(responsibilities).values({
      companyId: company.id, ownerUserId: OWNER, title: "Legacy", status: "proposed", source: "onboarding",
    }).returning();
    const confirmedBare = await request(app).patch(`/api/responsibilities/${legacy!.id}`).send({ status: "active" });
    expect(confirmedBare.status).toBe(200);
    expect(confirmedBare.body).toMatchObject({ status: "active", rollup: { health: "not_measured" } });

    // What is measured but no sentence and no target: half a bar.
    const [half] = await db.insert(responsibilities).values({
      companyId: company.id, ownerUserId: OWNER, title: "Calls", status: "proposed", source: "onboarding", metricName: "Calls made",
    }).returning();
    const refused = await request(app).patch(`/api/responsibilities/${half!.id}`).send({ status: "active" });
    expect(refused.status).toBe(422);
    // A row with no kind reads as a volume, so it needs a target.
    expect(refused.body.details).toEqual({ missing: ["standard", "metricTarget"], metricKind: "volume" });

    const confirmed = await request(app).patch(`/api/responsibilities/${half!.id}`)
      .send({ status: "active", ...METRIC });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("active");

    // Clearing part of the metric leaves half a bar; clearing all of it leaves none.
    expect((await request(app).patch(`/api/responsibilities/${half!.id}`).send({ metricName: null })).status).toBe(422);
    expect((await request(app).patch(`/api/responsibilities/${half!.id}`).send({ metricUnit: "investors" })).status).toBe(200);
    const cleared = await request(app).patch(`/api/responsibilities/${half!.id}`)
      .send({ metricName: null, metricUnit: null, metricTarget: null, metricCurrent: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      status: "active", standard: METRIC.standard, metricName: null, metricTarget: null, metricUnit: null,
      rollup: { health: "not_measured", metric: null },
    });
    // Sending a metric value again needs the whole metric.
    const halfAgain = await request(app).patch(`/api/responsibilities/${half!.id}`).send({ metricKind: "range", metricLow: 1 });
    expect(halfAgain.status).toBe(422);
  });

  it("lets agents only propose, and confirming activates a proposed area in the same step", async () => {
    await enable();
    const company = await seedCompany();
    const guide = await seedAgent(company.id);
    const agentApp = createApp(db, agentActor(company.id, guide.id));
    const boardApp = createApp(db, localBoardActor());

    const area = await request(agentApp).post(`/api/companies/${company.id}/responsibility-areas`).send({ title: "Fundraising", status: "active" });
    expect(area.status).toBe(201);
    expect(area.body).toMatchObject({ status: "proposed", source: "onboarding", proposedByAgentId: guide.id });

    expect((await request(agentApp).post(`/api/companies/${company.id}/responsibilities`).send({ title: "Pipeline", ...METRIC })).status).toBe(422);
    expect((await request(agentApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Pipeline", ...METRIC, ownerUserId: "stranger" })).status).toBe(404);
    // An agent always proposes the whole bar: a title alone, or the sentence alone, is refused.
    expect((await request(agentApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Pipeline", ownerUserId: OWNER })).status).toBe(400);
    expect((await request(agentApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Pipeline", ownerUserId: OWNER, standard: METRIC.standard })).status).toBe(400);
    expect((await request(agentApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Pipeline", ownerUserId: OWNER, standard: METRIC.standard, metricName: METRIC.metricName })).status).toBe(400);

    const proposed = await request(agentApp).post(`/api/companies/${company.id}/responsibilities`).send({
      title: "Pipeline",
      ...METRIC,
      ownerUserId: OWNER,
      areaId: area.body.id,
      status: "active",
      evidence: "Three pipeline reviews on the calendar every week",
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: "proposed", source: "onboarding", proposedByAgentId: guide.id, confirmedAt: null, areaId: area.body.id });

    const listed = await request(agentApp).get(`/api/companies/${company.id}/responsibilities?ownerUserId=${OWNER}`);
    expect(listed.body.proposed.map((row: { id: string }) => row.id)).toEqual([proposed.body.id]);
    // A proposed area a returned responsibility references is included.
    expect(listed.body.areas.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([[area.body.id, "proposed"]]);

    expect((await request(agentApp).patch(`/api/responsibilities/${proposed.body.id}`).send({ status: "active" })).status).toBe(403);
    const edited = await request(agentApp).patch(`/api/responsibilities/${proposed.body.id}`).send({ title: "Deal pipeline" });
    expect(edited.status).toBe(200);

    const confirmed = await request(boardApp).patch(`/api/responsibilities/${proposed.body.id}`).send({ status: "active" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmedAt).not.toBeNull();
    const [areaRow] = await db.select().from(responsibilityAreas).where(eq(responsibilityAreas.id, area.body.id));
    expect(areaRow?.status).toBe("active");
    const logged = await actions(company.id);
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "responsibility_area.created", entityId: area.body.id }),
      expect.objectContaining({ action: "responsibility_area.activated", entityId: area.body.id }),
    ]));

    // Once confirmed, the agent can no longer edit it (beyond the metric) and cannot delete it.
    expect((await request(agentApp).patch(`/api/responsibilities/${proposed.body.id}`).send({ title: "x" })).status).toBe(403);
    expect((await request(agentApp).delete(`/api/responsibilities/${proposed.body.id}`)).status).toBe(403);

    const dismissible = await request(agentApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "Portfolio", ...METRIC, ownerUserId: OWNER });
    const dismissed = await request(agentApp).patch(`/api/responsibilities/${dismissible.body.id}`).send({ status: "dismissed" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe("dismissed");
  });

  it("lets only the running or assigned agent report the metric on an active responsibility", async () => {
    await enable();
    const company = await seedCompany();
    const runner = await seedAgent(company.id, "Runner");
    const worker = await seedAgent(company.id, "Worker");
    const bystander = await seedAgent(company.id, "Bystander");
    const boardApp = createApp(db, localBoardActor());
    const area = await createResponsibility(boardApp, company.id, { runByAgentId: runner.id, metricCurrent: 4 });
    expect(area.runByAgentId).toBe(runner.id);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Pipeline" }).returning().then((r) => r[0]!);
    await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Call LPs", status: "todo", priority: "medium", assigneeAgentId: worker.id });
    expect((await request(boardApp).post(`/api/responsibilities/${area.id}/links`).send({ projectId: project.id })).status).toBe(201);

    const asRunner = await request(createApp(db, agentActor(company.id, runner.id))).patch(`/api/responsibilities/${area.id}`).send({ metricCurrent: 9 });
    expect(asRunner.status).toBe(200);
    expect(asRunner.body.metricCurrent).toBe(9);
    expect(asRunner.body.metricUpdatedAt).not.toBeNull();
    // Assigned a task under it through its linked project.
    const asWorker = await request(createApp(db, agentActor(company.id, worker.id))).patch(`/api/responsibilities/${area.id}`).send({ metricCurrent: 16 });
    expect(asWorker.status).toBe(200);
    expect(asWorker.body.rollup.health).toBe("at_risk");

    const bystanderApp = createApp(db, agentActor(company.id, bystander.id));
    expect((await request(bystanderApp).patch(`/api/responsibilities/${area.id}`).send({ metricCurrent: 20 })).status).toBe(403);
    // Even the runner can only send metricCurrent.
    const runnerApp = createApp(db, agentActor(company.id, runner.id));
    expect((await request(runnerApp).patch(`/api/responsibilities/${area.id}`).send({ metricCurrent: 20, metricTarget: 10 })).status).toBe(403);
    expect((await request(runnerApp).patch(`/api/responsibilities/${area.id}`).send({ title: "Mine" })).status).toBe(403);

    // A routine assignee also counts.
    const routine = await db.insert(routines).values({ companyId: company.id, title: "Weekly sync", assigneeAgentId: bystander.id }).returning().then((r) => r[0]!);
    await request(boardApp).post(`/api/responsibilities/${area.id}/links`).send({ routineId: routine.id });
    expect((await request(bystanderApp).patch(`/api/responsibilities/${area.id}`).send({ metricCurrent: 20 })).status).toBe(200);

    const metricActions = (await actions(company.id)).filter((entry) => entry.action === "responsibility.metric_updated");
    expect(metricActions.map((entry) => entry.details)).toEqual([
      { metricName: "Investors contacted", from: 4, to: 9 },
      { metricName: "Investors contacted", from: 9, to: 16 },
      { metricName: "Investors contacted", from: 16, to: 20 },
    ]);
    expect((await actions(company.id)).some((entry) => entry.action === "responsibility.updated")).toBe(false);
  });

  it("keeps board users to their own responsibilities unless they administer the company", async () => {
    await enable();
    const company = await seedCompany();
    const ownerApp = createApp(db, localBoardActor());
    const area = await createResponsibility(ownerApp, company.id);
    const operatorApp = createApp(db, sessionBoardActor(company.id, "other-user"));
    expect((await request(operatorApp).get(`/api/responsibilities/${area.id}`)).status).toBe(200);
    expect((await request(operatorApp).patch(`/api/responsibilities/${area.id}`).send({ title: "Mine now" })).status).toBe(403);
    expect((await request(operatorApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "For someone else", ...METRIC, ownerUserId: OWNER })).status).toBe(403);
    const own = await createResponsibility(operatorApp, company.id, { title: "Ops" });
    expect(own.ownerUserId).toBe("other-user");
  });

  it("isolates companies on read, link, lookup, areas and delegate", async () => {
    await enable();
    const company = await seedCompany("A");
    const other = await seedCompany("B");
    const boardApp = createApp(db, localBoardActor());
    const area = await createResponsibility(boardApp, company.id);
    const otherAgent = await seedAgent(other.id, "Other guide");
    const otherProject = await db.insert(projects).values({ companyId: other.id, name: "B project" }).returning().then((r) => r[0]!);
    const otherArea = await request(createApp(db, sessionBoardActor(other.id, "other-user", "owner")))
      .post(`/api/companies/${other.id}/responsibility-areas`).send({ title: "B area" });

    for (const app of [
      createApp(db, sessionBoardActor(other.id, "other-user", "owner")),
      createApp(db, agentActor(other.id, otherAgent.id)),
    ]) {
      expect((await request(app).get(`/api/responsibilities/${area.id}`)).status).toBe(404);
      expect((await request(app).post(`/api/responsibilities/${area.id}/links`).send({ projectId: otherProject.id })).status).toBe(404);
      expect((await request(app).get(`/api/companies/${company.id}/responsibilities?ownerUserId=${OWNER}`)).status).toBe(403);
      expect((await request(app).get(`/api/companies/${company.id}/responsibility-links/lookup?projectId=${otherProject.id}`)).status).toBe(403);
      expect((await request(app).get(`/api/companies/${company.id}/responsibility-areas`)).status).toBe(403);
    }
    const otherBoard = createApp(db, sessionBoardActor(other.id, "other-user", "owner"));
    expect((await request(otherBoard).post(`/api/responsibilities/${area.id}/delegate`)
      .send({ title: "x", assigneeAgentId: otherAgent.id, mode: "handle_and_tell_me" })).status).toBe(404);

    // The owning company cannot file another company's project, use its area or its agent.
    expect((await request(boardApp).post(`/api/responsibilities/${area.id}/links`).send({ projectId: otherProject.id })).status).toBe(404);
    expect((await request(boardApp).get(`/api/companies/${company.id}/responsibility-links/lookup?projectId=${otherProject.id}`)).status).toBe(404);
    expect((await request(boardApp).patch(`/api/responsibilities/${area.id}`).send({ areaId: otherArea.body.id })).status).toBe(404);
    expect((await request(boardApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "x", ...METRIC, runByAgentId: otherAgent.id })).status).toBe(404);
    expect((await request(boardApp).patch(`/api/responsibility-areas/${otherArea.body.id}`).send({ title: "Mine" })).status).toBe(200);
    expect((await request(createApp(db, sessionBoardActor(company.id, OWNER, "owner")))
      .patch(`/api/responsibility-areas/${otherArea.body.id}`).send({ title: "Mine" })).status).toBe(404);
    expect(await db.select().from(responsibilityLinks).where(eq(responsibilityLinks.companyId, company.id))).toHaveLength(0);
  });

  it("files an item under several responsibilities and counts it once in the totals", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const first = await createResponsibility(app, company.id, { title: "Fundraising" });
    const second = await createResponsibility(app, company.id, { title: "LP relations" });
    const project = await db.insert(projects).values({ companyId: company.id, name: "Fund VI" }).returning().then((r) => r[0]!);
    const [inProject, alsoDirect] = await db.insert(issues).values([
      { companyId: company.id, projectId: project.id, title: "Draft deck", status: "todo", priority: "medium" },
      { companyId: company.id, projectId: project.id, title: "Data room", status: "todo", priority: "medium" },
    ]).returning();

    const linked = await request(app).post(`/api/responsibilities/${first.id}/links`).send({ projectId: project.id });
    expect(linked.status).toBe(201);
    expect(linked.body).toEqual({ link: expect.objectContaining({ responsibilityId: first.id, projectId: project.id }) });
    const again = await request(app).post(`/api/responsibilities/${first.id}/links`).send({ projectId: project.id });
    expect(again.status).toBe(200);
    expect(again.body.link.id).toBe(linked.body.link.id);
    const alsoSecond = await request(app).post(`/api/responsibilities/${second.id}/links`).send({ projectId: project.id });
    expect(alsoSecond.status).toBe(201);
    // Also filed directly under the first: still counted once there.
    expect((await request(app).post(`/api/responsibilities/${first.id}/links`).send({ issueId: alsoDirect!.id })).status).toBe(201);

    // Another person's responsibility can take it too.
    const otherApp = createApp(db, sessionBoardActor(company.id, "other-user"));
    const othersArea = await createResponsibility(otherApp, company.id, { title: "Ops" });
    expect((await request(otherApp).post(`/api/responsibilities/${othersArea.id}/links`).send({ projectId: project.id })).status).toBe(201);
    expect(await db.select().from(responsibilityLinks).where(eq(responsibilityLinks.companyId, company.id))).toHaveLength(4);

    const overview = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    for (const row of overview.body.responsibilities as Array<{ rollup: { openTasks: number; projects: number } }>) {
      expect(row.rollup).toMatchObject({ openTasks: 2, projects: 1 });
    }
    // The project sits under both of this owner's responsibilities and counts once.
    expect(overview.body.totals).toMatchObject({
      openTasks: 2, agentTasks: 0, userTasks: 2, blockedTasks: 0, projects: 1, lateProjects: 0,
    });

    const detail = await request(app).get(`/api/responsibilities/${first.id}`);
    const memberships = Object.fromEntries(detail.body.tasks.map((task: { id: string; membership: string }) => [task.id, task.membership]));
    expect(memberships).toEqual({ [inProject!.id]: "project", [alsoDirect!.id]: "direct" });

    // The database enforces one link per (responsibility, target) and exactly one target per link.
    await expect(db.insert(responsibilityLinks).values({ companyId: company.id, responsibilityId: first.id, projectId: project.id }))
      .rejects.toThrow();
    await expect(db.insert(responsibilityLinks).values({ companyId: company.id, responsibilityId: first.id }))
      .rejects.toThrow();
    expect((await request(app).post(`/api/responsibilities/${first.id}/links`).send({ projectId: project.id, issueId: randomUUID() })).status).toBe(400);

    const unlinked = await request(app).delete(`/api/responsibilities/${second.id}/links/${alsoSecond.body.link.id}`);
    expect(unlinked.status).toBe(200);
    expect((await request(app).delete(`/api/responsibilities/${second.id}/links/${alsoSecond.body.link.id}`)).status).toBe(404);
    const logged = (await actions(company.id)).map((entry) => entry.action).filter((action) => action !== "responsibility.created").sort();
    expect(logged).toEqual(["responsibility.linked", "responsibility.linked", "responsibility.linked", "responsibility.linked", "responsibility.unlinked"]);
  });

  it("finds every responsibility an item is under, directly or through its project", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const fundraising = await createResponsibility(app, company.id, { title: "Fundraising" });
    const lp = await createResponsibility(app, company.id, { title: "LP relations" });
    const dismissed = await createResponsibility(app, company.id, { title: "Dismissed" });
    const project = await db.insert(projects).values({ companyId: company.id, name: "Fund VI" }).returning().then((r) => r[0]!);
    const task = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Deck", status: "todo", priority: "medium" })
      .returning().then((r) => r[0]!);
    const loose = await db.insert(issues).values({ companyId: company.id, title: "Loose", status: "todo", priority: "medium" })
      .returning().then((r) => r[0]!);
    const routine = await db.insert(routines).values({ companyId: company.id, projectId: project.id, title: "Weekly" }).returning().then((r) => r[0]!);
    await request(app).post(`/api/responsibilities/${fundraising.id}/links`).send({ projectId: project.id });
    await request(app).post(`/api/responsibilities/${lp.id}/links`).send({ issueId: task.id });
    await request(app).post(`/api/responsibilities/${dismissed.id}/links`).send({ issueId: task.id });
    await request(app).patch(`/api/responsibilities/${dismissed.id}`).send({ status: "dismissed" });

    const lookup = (query: string) => request(app).get(`/api/companies/${company.id}/responsibility-links/lookup?${query}`);
    const byTask = await lookup(`issueId=${task.id}`);
    expect(byTask.status).toBe(200);
    expect(byTask.body).toEqual({
      responsibilities: [
        { id: fundraising.id, title: "Fundraising", areaId: null, ownerUserId: OWNER, via: "project" },
        { id: lp.id, title: "LP relations", areaId: null, ownerUserId: OWNER, via: "direct" },
      ],
    });
    expect((await lookup(`projectId=${project.id}`)).body.responsibilities).toEqual([
      { id: fundraising.id, title: "Fundraising", areaId: null, ownerUserId: OWNER, via: "direct" },
    ]);
    expect((await lookup(`routineId=${routine.id}`)).body.responsibilities).toEqual([
      expect.objectContaining({ id: fundraising.id, via: "project" }),
    ]);
    expect((await lookup(`issueId=${loose.id}`)).body).toEqual({ responsibilities: [] });
    expect((await lookup("")).status).toBe(400);
    expect((await lookup(`issueId=${task.id}&projectId=${project.id}`)).status).toBe(400);
    expect((await lookup(`issueId=${randomUUID()}`)).status).toBe(404);

    const guide = await seedAgent(company.id);
    const agentLookup = await request(createApp(db, agentActor(company.id, guide.id)))
      .get(`/api/companies/${company.id}/responsibility-links/lookup?issueId=${task.id}`);
    expect(agentLookup.status).toBe(200);
    expect(agentLookup.body.responsibilities).toHaveLength(2);
  });

  it("manages areas: idempotent create, board-only edits, delete keeps responsibilities", async () => {
    await enable();
    const company = await seedCompany();
    const guide = await seedAgent(company.id);
    const boardApp = createApp(db, localBoardActor());
    const agentApp = createApp(db, agentActor(company.id, guide.id));
    const areasPath = `/api/companies/${company.id}/responsibility-areas`;

    const created = await request(boardApp).post(areasPath).send({ title: "Fundraising", description: "Money in" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Fundraising", status: "active", source: "manual", proposedByAgentId: null });
    const same = await request(boardApp).post(areasPath).send({ title: "  fundraising " });
    expect(same.status).toBe(200);
    expect(same.body.id).toBe(created.body.id);
    const agentSame = await request(agentApp).post(areasPath).send({ title: "FUNDRAISING" });
    expect(agentSame.status).toBe(200);
    expect(agentSame.body).toMatchObject({ id: created.body.id, status: "active" });
    const customers = await request(agentApp).post(areasPath).send({ title: "Customers" });
    expect(customers.body.status).toBe("proposed");

    expect((await request(agentApp).patch(`/api/responsibility-areas/${created.body.id}`).send({ title: "x" })).status).toBe(403);
    expect((await request(agentApp).delete(`/api/responsibility-areas/${created.body.id}`)).status).toBe(403);
    expect((await request(createApp(db, sessionBoardActor(company.id, "viewer", "viewer"))).post(areasPath).send({ title: "Viewers" })).status).toBe(403);
    // Any board user with write access manages areas: they have no owner.
    const operatorApp = createApp(db, sessionBoardActor(company.id, "other-user"));
    expect((await request(operatorApp).patch(`/api/responsibility-areas/${customers.body.id}`).send({ status: "active", sortOrder: 2 })).status).toBe(200);

    const clash = await request(boardApp).patch(`/api/responsibility-areas/${customers.body.id}`).send({ title: "fundraising" });
    expect(clash.status).toBe(409);
    const archived = await request(boardApp).patch(`/api/responsibility-areas/${created.body.id}`).send({ status: "archived" });
    expect(archived.body.status).toBe("archived");
    expect((await request(boardApp).get(areasPath)).body.map((area: { title: string }) => area.title)).toEqual(["Customers"]);
    expect((await request(boardApp).get(`${areasPath}?includeArchived=true`)).body).toHaveLength(2);
    // A new Fundraising can exist once the old one is archived; filing under an archived area is refused.
    expect((await request(boardApp).post(areasPath).send({ title: "Fundraising" })).status).toBe(201);
    expect((await request(boardApp).post(`/api/companies/${company.id}/responsibilities`)
      .send({ title: "x", ...METRIC, areaId: created.body.id })).status).toBe(422);

    const under = await createResponsibility(boardApp, company.id, { areaId: customers.body.id });
    const removed = await request(boardApp).delete(`/api/responsibility-areas/${customers.body.id}`);
    expect(removed.status).toBe(200);
    const [kept] = await db.select().from(responsibilities).where(eq(responsibilities.id, under.id));
    expect(kept?.areaId).toBeNull();

    const areaActions = (await actions(company.id)).filter((entry) => entry.action.startsWith("responsibility_area.")).map((entry) => entry.action).sort();
    expect(areaActions).toEqual([
      "responsibility_area.created", "responsibility_area.created", "responsibility_area.created",
      "responsibility_area.deleted", "responsibility_area.updated", "responsibility_area.updated",
    ]);
  });

  it("summarizes the work under a responsibility and lists the areas and loose work in the overview", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const analyst = await seedAgent(company.id, "Analyst");
    const areaRes = await request(app).post(`/api/companies/${company.id}/responsibility-areas`).send({ title: "Fundraising" });
    await request(app).post(`/api/companies/${company.id}/responsibility-areas`).send({ title: "Team" });
    const area = await createResponsibility(app, company.id, { areaId: areaRes.body.id, metricCurrent: 10 });
    await db.update(responsibilities).set({ metricUpdatedAt: new Date(Date.now() - 20 * DAY) }).where(eq(responsibilities.id, area.id));

    const late = await db.insert(projects).values({ companyId: company.id, name: "Fund VI deck", status: "in_progress", targetDate: isoDaysFromNow(-30) })
      .returning().then((r) => r[0]!);
    const soon = await db.insert(projects).values({ companyId: company.id, name: "Data room", status: "planned", targetDate: isoDaysFromNow(3) })
      .returning().then((r) => r[0]!);
    await db.insert(issues).values([
      { companyId: company.id, projectId: late.id, title: "Draft deck", status: "in_progress", priority: "medium", assigneeAgentId: analyst.id },
      { companyId: company.id, projectId: late.id, title: "Legal review", status: "blocked", priority: "medium" },
      { companyId: company.id, projectId: soon.id, title: "Upload", status: "done", priority: "medium", completedAt: new Date() },
    ]);
    const failing = await db.insert(routines).values({ companyId: company.id, title: "CRM sync", assigneeAgentId: analyst.id }).returning().then((r) => r[0]!);
    const paused = await db.insert(routines).values({ companyId: company.id, title: "Monthly letter", status: "paused" }).returning().then((r) => r[0]!);
    await db.insert(routineRuns).values({ companyId: company.id, routineId: failing.id, source: "schedule", status: "failed", triggeredAt: new Date(Date.now() - DAY) });
    await db.insert(routineTriggers).values({ companyId: company.id, routineId: failing.id, kind: "schedule", nextRunAt: new Date(Date.now() + DAY) });
    for (const body of [{ projectId: late.id }, { projectId: soon.id }, { routineId: failing.id }, { routineId: paused.id }]) {
      expect((await request(app).post(`/api/responsibilities/${area.id}/links`).send(body)).status).toBe(201);
    }

    // Loose work, under no live responsibility.
    const looseProject = await db.insert(projects).values({ companyId: company.id, name: "Office move", status: "planned" }).returning().then((r) => r[0]!);
    const looseTask = await db.insert(issues).values({ companyId: company.id, title: "Renew domain", status: "todo", priority: "low" }).returning().then((r) => r[0]!);
    await db.insert(issues).values({ companyId: company.id, title: "Done loose", status: "done", priority: "low" });
    const looseRoutine = await db.insert(routines).values({ companyId: company.id, title: "Standup prep" }).returning().then((r) => r[0]!);
    await db.insert(projects).values({ companyId: company.id, name: "Finished", status: "completed" });

    const detail = await request(app).get(`/api/responsibilities/${area.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.area).toEqual({ id: areaRes.body.id, title: "Fundraising", status: "active" });
    const { rollup } = detail.body;
    expect(rollup).toMatchObject({
      health: "behind", projects: 2, routines: 2, openTasks: 2, blockedTasks: 1, agentTasks: 1, userTasks: 1, doneTasks: 1,
      nextDueAt: late.targetDate,
    });
    expect(rollup.metric.stale).toBe(true);
    const kinds = rollup.workSummary.map((signal: { kind: string }) => signal.kind);
    expect(kinds).toEqual([
      "metric_stale", "project_late", "routine_failed", "task_blocked", "project_due_soon", "routine_paused",
      "tasks_open_agent", "tasks_open_unassigned", "tasks_completed_recently",
    ]);
    const text = (kind: string) => rollup.workSummary.find((signal: { kind: string }) => signal.kind === kind).text;
    expect(text("metric_stale")).toBe("Investors contacted was last updated 20 days ago");
    expect(text("project_late")).toMatch(/^Fund VI deck is \d+ days past its target date$/);
    expect(text("routine_failed")).toMatch(/^CRM sync failed on its last run \(\d{4}-\d{2}-\d{2}\)$/);
    expect(text("project_due_soon")).toMatch(/^Data room is due in [234] days$/);
    expect(text("tasks_open_agent")).toBe("1 open task with Analyst");
    expect(text("tasks_completed_recently")).toBe("1 task completed in the last 7 days");
    expect(detail.body.routines.map((routine: { title: string; membership: string }) => [routine.title, routine.membership]))
      .toEqual([["CRM sync", "direct"], ["Monthly letter", "direct"]]);

    const overview = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    expect(overview.body.areas.map((row: { title: string; activeResponsibilities: number; byHealth: Record<string, number> }) =>
      [row.title, row.activeResponsibilities, row.byHealth.behind])).toEqual([["Fundraising", 1, 1], ["Team", 0, 0]]);
    expect(overview.body.loose).toMatchObject({ projectCount: 1, openTaskCount: 1, routineCount: 1 });
    expect(overview.body.loose.projects.map((row: { id: string }) => row.id)).toEqual([looseProject.id]);
    expect(overview.body.loose.tasks.map((row: { id: string }) => row.id)).toEqual([looseTask.id]);
    expect(overview.body.loose.routines).toEqual([
      { id: looseRoutine.id, title: "Standup prep", status: "active", assigneeAgentId: null, projectId: null },
    ]);
    expect(overview.body.loose.tasks[0]).toMatchObject({ identifier: null, title: "Renew domain", status: "todo", assigneeAgentId: null, projectId: null });

    // Work under a dismissed responsibility is loose again.
    await request(app).patch(`/api/responsibilities/${area.id}`).send({ status: "dismissed" });
    const after = await request(app).get(`/api/companies/${company.id}/responsibilities`);
    expect(after.body.loose).toMatchObject({ projectCount: 3, openTaskCount: 3, routineCount: 2 });

    // The bar stays put: overrides move the status, not the work.
    await request(app).patch(`/api/responsibilities/${area.id}`).send({ status: "active" });
    const overridden = await request(app).patch(`/api/responsibilities/${area.id}`).send({ healthOverride: "at_risk", healthNote: "LPs moved the date" });
    expect(overridden.body.rollup).toMatchObject({ health: "at_risk", computedHealth: "behind", healthOverridden: true });
    expect(overridden.body.healthNote).toBe("LPs moved the date");
  });

  it("shows the skills behind a responsibility and the artifacts its tasks produced", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    await db.insert(companySkills).values([
      { companyId: company.id, key: "acme/skills/deck-writing", slug: "deck-writing", name: "Deck writing", markdown: "# Deck", tagline: "Pitch decks", color: "#336699" },
      { companyId: company.id, key: "acme/skills/crm", slug: "crm", name: "CRM upkeep", markdown: "# CRM" },
      { companyId: company.id, key: "acme/skills/unused", slug: "unused", name: "Unused", markdown: "# Unused" },
      { companyId: company.id, key: "paperclipai/paperclip/paperclip", slug: "paperclip", name: "Paperclip", markdown: "# Core" },
    ]);
    const runner = await seedAgent(company.id, "Runner", ["acme/skills/deck-writing", "paperclipai/paperclip/paperclip"]);
    const writer = await seedAgent(company.id, "Writer", ["acme/skills/deck-writing", "acme/skills/crm"]);
    await seedAgent(company.id, "Idle", ["acme/skills/unused"]);
    const area = await createResponsibility(app, company.id, { runByAgentId: runner.id });
    const project = await db.insert(projects).values({ companyId: company.id, name: "Fund VI" }).returning().then((r) => r[0]!);
    const projectTask = await db.insert(issues).values({
      companyId: company.id, projectId: project.id, title: "Draft deck", status: "in_progress", priority: "medium", assigneeAgentId: writer.id,
    }).returning().then((r) => r[0]!);
    const otherTask = await db.insert(issues).values({ companyId: company.id, title: "Elsewhere", status: "todo", priority: "low" })
      .returning().then((r) => r[0]!);
    await request(app).post(`/api/responsibilities/${area.id}/links`).send({ projectId: project.id });

    const [deck, summary, review, elsewhere] = await db.insert(documents).values([
      { companyId: company.id, title: "Deck outline", latestBody: "# Outline", createdByAgentId: writer.id, updatedAt: new Date(Date.now() - 1000) },
      { companyId: company.id, title: "Summary", latestBody: "summary", createdByAgentId: writer.id },
      { companyId: company.id, title: "Review", latestBody: "review", createdByAgentId: writer.id },
      { companyId: company.id, title: "Elsewhere doc", latestBody: "x", createdByAgentId: writer.id },
    ]).returning();
    await db.insert(issueDocuments).values([
      { companyId: company.id, issueId: projectTask.id, documentId: deck!.id, key: "outline" },
      { companyId: company.id, issueId: projectTask.id, documentId: summary!.id, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY },
      { companyId: company.id, issueId: projectTask.id, documentId: review!.id, key: `artifact-review-${randomUUID()}` },
      { companyId: company.id, issueId: otherTask.id, documentId: elsewhere!.id, key: "notes" },
    ]);

    const detail = await request(app).get(`/api/responsibilities/${area.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.skills).toEqual([
      expect.objectContaining({ key: "acme/skills/crm", name: "CRM upkeep", agentIds: [writer.id] }),
      expect.objectContaining({
        key: "acme/skills/deck-writing", name: "Deck writing", tagline: "Pitch decks", color: "#336699",
        agentIds: [runner.id, writer.id].sort(),
      }),
    ]);
    expect(detail.body.artifacts).toHaveLength(1);
    expect(detail.body.artifacts[0]).toMatchObject({
      id: `document:${deck!.id}`,
      title: "Deck outline",
      mediaKind: "document",
      issue: { id: projectTask.id, title: "Draft deck" },
      createdByAgent: { id: writer.id, name: "Writer" },
    });
    expect(detail.body).toMatchObject({ artifactsTotal: 1, artifactsTruncated: false });
  });

  it("delegates work as an assigned task, and own_from_now_on makes the agent run the responsibility", async () => {
    await enable();
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "Associate");
    const owner = await seedAgent(company.id, "Owner agent");
    const wakeup = vi.fn(async () => ({ queued: true }));
    const app = createApp(db, localBoardActor(), { wakeup });
    const area = await createResponsibility(app, company.id, { title: "LP relations", standard: "Every LP hears from us monthly" });

    const res = await request(app).post(`/api/responsibilities/${area.id}/delegate`).send({
      title: "Send the Q3 LP letter",
      instructions: "Use last quarter's letter as the template.",
      assigneeAgentId: agent.id,
      mode: "handle_and_tell_me",
    });
    expect(res.status).toBe(201);
    expect(res.body.issue).toMatchObject({ title: "Send the Q3 LP letter", assigneeAgentId: agent.id, status: "todo", createdByUserId: OWNER });
    expect(res.body.issue.description.startsWith("**How to work:** Handle this end to end.")).toBe(true);
    expect(res.body.link).toMatchObject({ responsibilityId: area.id, issueId: res.body.issue.id });
    expect(wakeup).toHaveBeenCalledWith(agent.id, expect.objectContaining({
      source: "assignment",
      payload: expect.objectContaining({ issueId: res.body.issue.id }),
    }));
    let detail = await request(app).get(`/api/responsibilities/${area.id}`);
    expect(detail.body.runByAgentId).toBeNull();
    expect(detail.body.rollup).toMatchObject({ openTasks: 1, agentTasks: 1 });

    const owned = await request(app).post(`/api/responsibilities/${area.id}/delegate`).send({
      title: "Keep LPs updated", assigneeAgentId: owner.id, mode: "own_from_now_on",
    });
    expect(owned.status).toBe(201);
    expect(owned.body.issue.description).toContain('{ "metricCurrent": <number> }');
    detail = await request(app).get(`/api/responsibilities/${area.id}`);
    expect(detail.body.runByAgentId).toBe(owner.id);
    const delegated = (await actions(company.id)).filter((entry) => entry.action === "responsibility.delegated");
    expect(delegated.map((entry) => (entry.details as Record<string, unknown>).toRunByAgentId)).toEqual([undefined, owner.id]);

    const agentApp = createApp(db, agentActor(company.id, agent.id));
    expect((await request(agentApp).post(`/api/responsibilities/${area.id}/delegate`)
      .send({ title: "x", assigneeAgentId: agent.id, mode: "plan_with_me" })).status).toBe(403);
    const proposed = await createResponsibility(app, company.id, { title: "Later", status: "proposed" });
    expect((await request(app).post(`/api/responsibilities/${proposed.id}/delegate`)
      .send({ title: "x", assigneeAgentId: agent.id, mode: "plan_with_me" })).status).toBe(422);
  });

  it("gives each routine its last run and each project its progress, in a fixed number of queries", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const area = await createResponsibility(app, company.id);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Fund VI" }).returning().then((r) => r[0]!);
    const empty = await db.insert(projects).values({ companyId: company.id, name: "Data room" }).returning().then((r) => r[0]!);
    await db.insert(issues).values([
      { companyId: company.id, projectId: project.id, title: "Draft", status: "done", priority: "medium" },
      { companyId: company.id, projectId: project.id, title: "Review", status: "in_progress", priority: "medium" },
      { companyId: company.id, projectId: project.id, title: "Send", status: "todo", priority: "medium" },
      { companyId: company.id, projectId: project.id, title: "Dropped", status: "cancelled", priority: "medium" },
      { companyId: company.id, projectId: project.id, title: "Hidden", status: "done", priority: "medium", hiddenAt: new Date() },
    ]);
    const routine = (title: string, extra: Partial<typeof routines.$inferInsert> = {}) =>
      db.insert(routines).values({ companyId: company.id, title, ...extra }).returning().then((r) => r[0]!);
    const succeeded = await routine("Weekly review");
    const failed = await routine("CRM sync");
    const running = await routine("Pipeline digest");
    const never = await routine("Board prep");
    const paused = await routine("Monthly letter", { status: "paused" });
    const inProject = await routine("Deck refresh", { projectId: project.id });
    const run = (routineId: string, status: string, triggeredAt: Date, completedAt: Date | null = null) =>
      ({ companyId: company.id, routineId, source: "schedule", status, triggeredAt, completedAt });
    await db.insert(routineRuns).values([
      run(succeeded.id, "failed", hoursAgo(50), hoursAgo(49)),
      run(succeeded.id, "completed", hoursAgo(9), hoursAgo(8)),
      // Skipped and merged runs never ran: the completed one before them is its last run.
      run(succeeded.id, "skipped", hoursAgo(2)),
      run(succeeded.id, "coalesced", hoursAgo(1)),
      run(failed.id, "failed", hoursAgo(48), hoursAgo(47)),
      run(running.id, "issue_created", hoursAgo(3)),
      run(never.id, "skipped", hoursAgo(5)),
      run(paused.id, "completed", hoursAgo(30), hoursAgo(29)),
      run(inProject.id, "completed", hoursAgo(4), hoursAgo(3)),
    ]);
    for (const body of [
      { projectId: project.id }, { projectId: empty.id },
      ...[succeeded, failed, running, never, paused].map((entry) => ({ routineId: entry.id })),
    ]) expect((await request(app).post(`/api/responsibilities/${area.id}/links`).send(body)).status).toBe(201);

    const detail = await request(app).get(`/api/responsibilities/${area.id}`);
    expect(detail.status).toBe(200);
    const lastRuns = Object.fromEntries(detail.body.routines.map((entry: { title: string; lastRun: { outcome: string; at: string } | null }) =>
      [entry.title, entry.lastRun && { outcome: entry.lastRun.outcome, hoursAgo: Math.round((Date.now() - Date.parse(entry.lastRun.at)) / 3_600_000) }]));
    expect(lastRuns).toEqual({
      "Weekly review": { outcome: "succeeded", hoursAgo: 8 },
      "CRM sync": { outcome: "failed", hoursAgo: 47 },
      "Pipeline digest": { outcome: "running", hoursAgo: 3 },
      "Board prep": null,
      "Monthly letter": { outcome: "succeeded", hoursAgo: 29 },
      "Deck refresh": { outcome: "succeeded", hoursAgo: 3 },
    });
    // Done of the tasks the reader can see that were not cancelled; none at all is no progress.
    expect(Object.fromEntries(detail.body.projects.map((entry: { name: string; progress: unknown }) => [entry.name, entry.progress])))
      .toEqual({ "Fund VI": { done: 1, total: 3 }, "Data room": null });

    const count = async (responsibilityId: string) => {
      const queries: string[] = [];
      const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: (query) => queries.push(query) } }) as unknown as Db;
      const res = await request(createApp(recorded, localBoardActor())).get(`/api/responsibilities/${responsibilityId}`);
      expect(res.status).toBe(200);
      return { queries: queries.length, routines: res.body.routines.length as number };
    };
    // One routine and one project against six routines and two projects: the same number of queries.
    const small = await createResponsibility(app, company.id, { title: "Small" });
    await request(app).post(`/api/responsibilities/${small.id}/links`).send({ routineId: failed.id });
    await request(app).post(`/api/responsibilities/${small.id}/links`).send({ projectId: empty.id });
    const few = await count(small.id);
    const many = await count(area.id);
    expect([few.routines, many.routines]).toEqual([1, 6]);
    expect(many.queries).toBe(few.queries);
  });

  it("lets only board users delete a responsibility, which removes its links", async () => {
    await enable();
    const company = await seedCompany();
    const app = createApp(db, localBoardActor());
    const area = await createResponsibility(app, company.id);
    const project = await db.insert(projects).values({ companyId: company.id, name: "P" }).returning().then((r) => r[0]!);
    await request(app).post(`/api/responsibilities/${area.id}/links`).send({ projectId: project.id });
    const removed = await request(app).delete(`/api/responsibilities/${area.id}`);
    expect(removed.status).toBe(200);
    expect(await db.select().from(responsibilityLinks).where(eq(responsibilityLinks.companyId, company.id))).toHaveLength(0);
    expect((await request(app).get(`/api/responsibilities/${area.id}`)).status).toBe(404);
    const [deleted] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "responsibility.deleted")));
    expect(deleted?.entityId).toBe(area.id);
  });
});
