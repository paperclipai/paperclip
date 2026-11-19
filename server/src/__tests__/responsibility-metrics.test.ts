import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  responsibilities,
  responsibilityLinks,
  responsibilityMetricReadings,
  responsibilityMetrics,
} from "@paperclipai/db";
import { RESPONSIBILITY_METRIC_HISTORY_LIMIT } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityBarRoutes } from "../routes/responsibility-bars.js";
import { responsibilityMetricRoutes } from "../routes/responsibility-metrics.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { loadResponsibilityBarGuidance } from "../services/responsibility-bar-guidance.js";
import { primaryReadings, responsibilityMetricService } from "../services/responsibility-metrics.js";
import { responsibilityService } from "../services/responsibilities.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_METRICS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";
const OTHER = "other-user";
const DAY_MS = 86_400_000;

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

const SUPPORTING = [
  {
    title: "Intro meetings booked per week",
    description: "Calendar events with a prospective investor booked that week",
    display: "bar",
    target: 3,
    direction: "at_least",
    readings: [
      { value: 1, recordedAt: new Date(Date.now() - 21 * DAY_MS).toISOString() },
      { value: 2, recordedAt: new Date(Date.now() - 14 * DAY_MS).toISOString() },
      { value: 4, recordedAt: new Date(Date.now() - 7 * DAY_MS).toISOString() },
    ],
    readingsEvidence: "Counted from the shared calendar",
  },
  {
    title: "Investor emails answered within a day",
    description: "Share of inbound investor emails with a reply inside 24 hours",
    display: "percent",
    target: 90,
  },
];

describeEmbeddedPostgres("responsibility metric sets", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-metrics-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    const heartbeat: IssueAssignmentWakeupDeps = { wakeup: vi.fn(async () => ({ queued: true })) as unknown as IssueAssignmentWakeupDeps["wakeup"] };
    app.use("/api", responsibilityRoutes(db, { heartbeat }));
    app.use("/api", responsibilityBarRoutes(db, { heartbeat }));
    app.use("/api", responsibilityMetricRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Metric Co", issuePrefix: `M${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: OTHER, status: "active", membershipRole: "operator" },
    ]);
    const [ceo, analyst] = await db.insert(agents).values([
      { companyId: company.id, name: "Chief", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Analyst", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} },
    ]).returning();
    const app = createApp(localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({
      title: "Fundraising", standard: "We talk to enough investors", metricName: "Investors contacted", metricTarget: 20, metricCurrent: 9,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    // A task the analyst works under it, and one finished this week.
    const [open, finished] = await db.insert(issues).values([
      { companyId: company.id, title: "Draft the update", status: "in_progress", priority: "medium", assigneeAgentId: analyst!.id },
      { companyId: company.id, title: "Send the deck", status: "done", priority: "medium", completedAt: new Date(Date.now() - 2 * DAY_MS) },
    ]).returning();
    await db.insert(responsibilityLinks).values([
      { companyId: company.id, responsibilityId: id, issueId: open!.id },
      { companyId: company.id, responsibilityId: id, issueId: finished!.id },
    ]);
    return { company, ceo: ceo!, analyst: analyst!, app, id };
  }

  const read = (app: express.Express, id: string) => request(app).get(`/api/responsibilities/${id}/metrics`);
  const record = (app: express.Express, id: string, metric: string, body: object) =>
    request(app).post(`/api/responsibilities/${id}/metrics/${metric}/readings`).send(body);

  describe("the read", () => {
    it("is 404 with the flag off, and follows the detail route's access", async () => {
      const seeded = await seed();
      expect((await read(createApp(sessionBoardActor(seeded.company.id, OTHER)), seeded.id)).status).toBe(200);
      expect((await read(createApp(agentActor(seeded.company.id, seeded.ceo.id)), seeded.id)).status).toBe(200);
      // Another company's board user gets what the detail route gives them.
      const outsider = createApp(sessionBoardActor(randomUUID(), OTHER));
      const detail = await request(outsider).get(`/api/responsibilities/${seeded.id}`);
      expect((await read(outsider, seeded.id)).status).toBe(detail.status);
      expect(detail.status).toBe(404);
      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      expect((await read(seeded.app, seeded.id)).status).toBe(404);
    });

    it("shows starters computed from the work when nobody chose a set, and stores nothing", async () => {
      const seeded = await seed();
      const res = await read(seeded.app, seeded.id);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("starter");
      expect(res.body.metrics.map((metric: { key: string; display: string }) => [metric.key, metric.display])).toEqual([
        ["starter:bar_metric", "number"],
        ["starter:tasks_finished", "bar"],
        ["starter:automation_share", "percent"],
      ]);
      const [primary, finished] = res.body.metrics;
      expect(primary).toMatchObject({ role: "primary", title: "Investors contacted", target: 20, health: "behind", latest: { value: 9 } });
      expect(finished.readings).toHaveLength(6);
      expect(finished.readings.at(-1).value).toBe(1);
      // Only the reading's history row exists; no starter is stored.
      const rows = await db.select().from(responsibilityMetrics).where(eq(responsibilityMetrics.responsibilityId, seeded.id));
      expect(rows.map((row) => [row.position, row.title, row.createdByUserId])).toEqual([[0, "Investors contacted", null]]);
    });

    it("returns at most the newest readings of each metric, oldest first", async () => {
      const seeded = await seed();
      for (let week = 15; week >= 1; week -= 1) {
        const res = await record(seeded.app, seeded.id, "primary", { value: 20 - week, recordedAt: new Date(Date.now() - week * 7 * DAY_MS).toISOString() });
        expect(res.status).toBe(201);
      }
      const res = await read(seeded.app, seeded.id);
      const primary = res.body.metrics[0];
      expect(primary.readings).toHaveLength(RESPONSIBILITY_METRIC_HISTORY_LIMIT);
      expect(primary.display).toBe("line");
      // The backfilled readings are older than the bar's own (9, today), which stays newest.
      expect(primary.readings.at(-1).value).toBe(9);
      const times = primary.readings.map((reading: { recordedAt: string }) => reading.recordedAt);
      expect([...times].sort()).toEqual(times);
    });
  });

  describe("readings", () => {
    it("mirrors the bar's reading into its history whenever it changes", async () => {
      const seeded = await seed();
      const patched = await request(createApp(agentActor(seeded.company.id, seeded.analyst.id)))
        .patch(`/api/responsibilities/${seeded.id}`).send({ metricCurrent: 12 });
      expect(patched.status).toBe(200);
      const [mirror] = await db.select().from(responsibilityMetrics).where(eq(responsibilityMetrics.responsibilityId, seeded.id));
      const history = await db.select().from(responsibilityMetricReadings).where(eq(responsibilityMetricReadings.metricId, mirror!.id));
      expect(history.map((reading) => [reading.value, reading.recordedByAgentId ?? reading.recordedByUserId])).toEqual(
        expect.arrayContaining([[9, OWNER], [12, seeded.analyst.id]]),
      );
      const res = await read(seeded.app, seeded.id);
      expect(res.body.metrics[0]).toMatchObject({ display: "line", latest: { value: 12 } });
      expect(res.body.metrics[0].readings).toHaveLength(2);
    });

    it("lets the agent working under it record now, never backdate or correct; others not at all", async () => {
      const seeded = await seed();
      const analyst = createApp(agentActor(seeded.company.id, seeded.analyst.id));
      const ceo = createApp(agentActor(seeded.company.id, seeded.ceo.id));
      expect((await record(ceo, seeded.id, "primary", { value: 11 })).status).toBe(403);
      expect((await record(analyst, seeded.id, "primary", { value: 11, recordedAt: new Date(Date.now() - DAY_MS).toISOString() })).status).toBe(403);
      const ok = await record(analyst, seeded.id, "primary", { value: 11, note: "From the CRM" });
      expect(ok.status).toBe(201);
      expect(ok.body.reading).toMatchObject({ metric: "primary", value: 11, current: true });
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row!.metricCurrent).toBe(11);
      expect((await record(analyst, seeded.id, "primary", { value: true })).status).toBe(422);
      // A teammate who does not own it may not record either.
      expect((await record(createApp(sessionBoardActor(seeded.company.id, OTHER)), seeded.id, "primary", { value: 3 })).status).toBe(403);
      const logged = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, seeded.company.id));
      expect(logged.map((entry) => entry.action)).toEqual(expect.arrayContaining(["responsibility.metric_reading_recorded", "responsibility.metric_updated"]));
    });

    it("lets the owner backfill history, record a newer reading and correct one", async () => {
      const seeded = await seed();
      const old = await record(seeded.app, seeded.id, "primary", { value: 4, recordedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() });
      expect(old.body.reading.current).toBe(false);
      let [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row!.metricCurrent).toBe(9);
      expect((await record(seeded.app, seeded.id, "primary", { value: 4, recordedAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(422);
      await record(seeded.app, seeded.id, "primary", { value: 13 });
      [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row!.metricCurrent).toBe(13);

      const set = await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: SUPPORTING });
      expect(set.status).toBe(200);
      const meetings = set.body.metrics.find((metric: { title: string }) => metric.title === SUPPORTING[0]!.title);
      const latest = meetings.readings.at(-1);
      const corrected = await record(seeded.app, seeded.id, meetings.id, { value: 5, readingId: latest.id });
      expect(corrected.body.reading).toMatchObject({ value: 5, corrected: true });
      expect((await record(createApp(agentActor(seeded.company.id, seeded.analyst.id)), seeded.id, meetings.id, { value: 5, readingId: latest.id })).status).toBe(403);
      const share = set.body.metrics.find((metric: { title: string }) => metric.title === SUPPORTING[1]!.title);
      expect((await record(seeded.app, seeded.id, share.id, { value: 140 })).status).toBe(422);
      expect((await record(createApp(agentActor(seeded.company.id, seeded.analyst.id)), seeded.id, share.id, { value: 82 })).status).toBe(201);
      const after = await read(seeded.app, seeded.id);
      expect(after.body.metrics.find((metric: { id: string }) => metric.id === meetings.id).readings.map((reading: { value: number }) => reading.value)).toEqual([1, 2, 5]);
      expect(after.body.metrics.find((metric: { id: string }) => metric.id === share.id).latest.value).toBe(82);
    });

    it("keeps the newest number when an older report commits after it", async () => {
      const seeded = await seed();
      const [stale] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      const staleAt = new Date(stale!.metricUpdatedAt!).getTime();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await record(seeded.app, seeded.id, "primary", { value: 13 })).status).toBe(201);
      const late = await responsibilityMetricService(db).record(
        stale!, "primary", { value: 4, recordedAt: new Date(staleAt + 5).toISOString() }, { type: "board", userId: OWNER },
      );
      expect(late).toMatchObject({ backfilled: true, updated: null });
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row!.metricCurrent).toBe(13);
      const readings = await read(seeded.app, seeded.id);
      expect(readings.body.metrics[0].readings.map((reading: { value: number }) => reading.value)).toEqual([9, 4, 13]);
    });

    it("refuses a reading checked against a bar that changed before it saved", async () => {
      const seeded = await seed();
      const [stale] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      await db.update(responsibilities).set({ metricKind: "yes_no", metricTarget: 1, metricCurrent: null, metricUpdatedAt: null })
        .where(eq(responsibilities.id, seeded.id));
      await expect(responsibilityService(db).update(stale!, { metricCurrent: 50 }, { type: "board", userId: OWNER })).rejects.toThrow();
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row).toMatchObject({ metricKind: "yes_no", metricCurrent: null });
    });

    it("takes the reading a bar change supplies, even behind a reading dated ahead", async () => {
      const seeded = await seed();
      await db.update(responsibilities).set({ metricUpdatedAt: new Date(Date.now() + 50_000) }).where(eq(responsibilities.id, seeded.id));
      const changed = await request(seeded.app).patch(`/api/responsibilities/${seeded.id}`).send({ metricTarget: 30, metricCurrent: 3 });
      expect(changed.status).toBe(200);
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.id));
      expect(row).toMatchObject({ metricTarget: 30, metricCurrent: 3 });
    });
  });

  describe("chosen sets", () => {
    it("lets the owner set and remove supporting metrics; others may not", async () => {
      const seeded = await seed();
      expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER))).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: SUPPORTING })).status).toBe(403);
      expect((await request(createApp(agentActor(seeded.company.id, seeded.analyst.id))).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: SUPPORTING })).status).toBe(403);
      expect((await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: [...SUPPORTING, { ...SUPPORTING[1], title: "Third" }] })).status).toBe(400);
      const set = await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: SUPPORTING, primaryDisplay: "line" });
      expect(set.body).toMatchObject({ source: "chosen", chosenBy: { userId: OWNER } });
      expect(set.body.metrics.map((metric: { title: string; display: string }) => [metric.title, metric.display])).toEqual([
        ["Investors contacted", "line"],
        [SUPPORTING[0]!.title, "bar"],
        [SUPPORTING[1]!.title, "percent"],
      ]);
      const removed = await request(seeded.app).delete(`/api/responsibilities/${seeded.id}/metrics/${set.body.metrics[2].id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.metrics).toHaveLength(2);
      expect((await request(seeded.app).delete(`/api/responsibilities/${seeded.id}/metrics/${randomUUID()}`)).status).toBe(404);
      expect((await request(seeded.app).delete(`/api/responsibilities/${seeded.id}/metrics/not-a-metric`)).status).toBe(404);
      expect((await record(seeded.app, seeded.id, "not-a-metric", { value: 1 })).status).toBe(404);
    });
  });

  describe("how each metric is shown", () => {
    const showAs = (app: express.Express, id: string, metric: string, display: string) =>
      request(app).patch(`/api/responsibilities/${id}/metrics/${metric}`).send({ display });

    it("switches a form among those its data allows, keeps its readings, and only for the owner", async () => {
      const seeded = await seed();
      const set = await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: SUPPORTING });
      const meetings = set.body.metrics.find((metric: { title: string }) => metric.title === SUPPORTING[0]!.title);
      const share = set.body.metrics.find((metric: { title: string }) => metric.title === SUPPORTING[1]!.title);

      // Per week to Trend: readings stay with it.
      const trend = await showAs(seeded.app, seeded.id, meetings.id, "line");
      expect(trend.status).toBe(200);
      const switched = trend.body.metrics.find((metric: { id: string }) => metric.id === meetings.id);
      expect(switched).toMatchObject({ display: "line", period: null });
      expect(switched.readings.map((reading: { value: number }) => reading.value)).toEqual([1, 2, 4]);
      // A count cannot become a percent; a share can become a number and back.
      expect((await showAs(seeded.app, seeded.id, meetings.id, "percent")).status).toBe(422);
      expect((await showAs(seeded.app, seeded.id, share.id, "number")).status).toBe(200);
      expect((await showAs(seeded.app, seeded.id, share.id, "percent")).body.metrics.find((metric: { id: string }) => metric.id === share.id).display).toBe("percent");
      expect((await showAs(seeded.app, seeded.id, meetings.id, "pie")).status).toBe(400);

      // The bar's own: a volume as a number, trend or per week; who chose the set stays.
      const primary = await showAs(seeded.app, seeded.id, "primary", "bar");
      expect(primary.status).toBe(200);
      expect(primary.body.metrics[0]).toMatchObject({ role: "primary", display: "bar", period: "week" });
      expect(primary.body).toMatchObject({ source: "chosen", chosenBy: { userId: OWNER } });
      expect((await showAs(seeded.app, seeded.id, "primary", "percent")).status).toBe(422);

      expect((await showAs(createApp(sessionBoardActor(seeded.company.id, OTHER)), seeded.id, "primary", "line")).status).toBe(403);
      expect((await showAs(createApp(agentActor(seeded.company.id, seeded.analyst.id)), seeded.id, "primary", "line")).status).toBe(403);
      expect((await showAs(seeded.app, seeded.id, randomUUID(), "line")).status).toBe(404);
      const logged = await db.select({ details: activityLog.details }).from(activityLog)
        .where(and(eq(activityLog.companyId, seeded.company.id), eq(activityLog.action, "responsibility.metric_display_changed")));
      expect(logged.map((entry) => entry.details)).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: meetings.id, from: "bar", to: "line" }),
        expect.objectContaining({ metric: "primary", to: "bar" }),
      ]));
      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      expect((await showAs(seeded.app, seeded.id, "primary", "line")).status).toBe(404);
    });

    it("shows a range bar's own metric only as a number or a trend", async () => {
      const seeded = await seed();
      await request(seeded.app).patch(`/api/responsibilities/${seeded.id}`).send({ metricKind: "range", metricName: "Runway", metricUnit: "months", metricLow: 12, metricHigh: 24, metricCurrent: 14 });
      expect((await showAs(seeded.app, seeded.id, "primary", "bar")).status).toBe(422);
      expect((await showAs(seeded.app, seeded.id, "primary", "line")).status).toBe(200);
    });
  });

  describe("the bar conversation's proposal", () => {
    async function conversation(seeded: Awaited<ReturnType<typeof seed>>) {
      const started = await request(seeded.app).post(`/api/responsibilities/${seeded.id}/bar-conversation`).send({ agentId: seeded.ceo.id });
      return started.body.conversation.issueId as string;
    }
    const BAR = {
      standard: "We talk to enough investors every month.",
      metricKind: "volume",
      metricName: "Investors contacted",
      metricTarget: 25,
    };

    it("carries up to two supporting metrics, and accepting replaces the set in one go", async () => {
      const seeded = await seed();
      await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: [SUPPORTING[1]] });
      const issueId = await conversation(seeded);
      const agent = createApp(agentActor(seeded.company.id, seeded.ceo.id));
      const tooMany = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({
        ...BAR, metrics: [SUPPORTING[0], SUPPORTING[1], { ...SUPPORTING[1], title: "Third" }],
      });
      expect(tooMany.status).toBe(400);
      const unexplained = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({
        ...BAR, metrics: [{ ...SUPPORTING[0], readingsEvidence: undefined }],
      });
      expect(unexplained.status).toBe(400);
      const proposed = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({
        ...BAR, primaryDisplay: "line", metrics: [SUPPORTING[0]],
      });
      expect(proposed.status).toBe(201);
      expect(proposed.body.payload).toMatchObject({
        primaryDisplay: "line",
        metrics: [{ title: SUPPORTING[0]!.title, display: "bar", target: 3, direction: "at_least", readingsEvidence: "Counted from the shared calendar" }],
      });
      expect(proposed.body.payload.metrics[0].readings).toHaveLength(3);
      // Nothing changes until the person accepts.
      expect((await read(seeded.app, seeded.id)).body.metrics.map((metric: { title: string }) => metric.title)).toContain(SUPPORTING[1]!.title);

      const accepted = await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${proposed.body.id}/accept`).send({});
      expect(accepted.status).toBe(200);
      const after = await read(seeded.app, seeded.id);
      expect(after.body).toMatchObject({ source: "chosen", chosenBy: { agentId: seeded.ceo.id } });
      expect(after.body.metrics.map((metric: { title: string; display: string }) => [metric.title, metric.display])).toEqual([
        ["Investors contacted", "line"],
        [SUPPORTING[0]!.title, "bar"],
      ]);
      expect(after.body.metrics[1].readings.map((reading: { value: number; recordedByAgentId: string }) => [reading.value, reading.recordedByAgentId]))
        .toEqual([[1, seeded.ceo.id], [2, seeded.ceo.id], [4, seeded.ceo.id]]);
      const archived = await db.select().from(responsibilityMetrics).where(and(
        eq(responsibilityMetrics.responsibilityId, seeded.id), eq(responsibilityMetrics.status, "archived"),
      ));
      expect(archived.map((metric) => metric.title)).toEqual([SUPPORTING[1]!.title]);
      const logged = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, seeded.company.id));
      expect(logged.map((entry) => entry.action)).toContain("responsibility.metrics_set");

      const guidance = await loadResponsibilityBarGuidance(db, {
        issue: { id: issueId, companyId: seeded.company.id, originKind: "responsibility_bar", originId: seeded.id, assigneeAgentId: seeded.ceo.id },
        agentId: seeded.ceo.id,
      });
      expect(guidance).toContain(`- Supporting metrics today:\n  - ${SUPPORTING[0]!.title} (bar)`);
      expect(guidance).toContain("explains movement in the primary one");
    });

    it("applies only the supporting metrics the person kept, records the dropped ones, and always applies the bar's own", async () => {
      const seeded = await seed();
      const issueId = await conversation(seeded);
      const agent = createApp(agentActor(seeded.company.id, seeded.ceo.id));
      const proposed = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({
        ...BAR, primaryDisplay: "line", metrics: SUPPORTING,
      });
      expect(proposed.status).toBe(201);
      const accept = (body: object) => request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${proposed.body.id}/accept`).send(body);
      // An index the proposal does not have, or one listed twice, is refused and nothing changes.
      expect((await accept({ keepMetrics: [1, 1] })).status).toBe(400);
      expect((await accept({ keepMetrics: [5] })).status).toBe(400);
      const pending = await db.select().from(responsibilityMetrics).where(eq(responsibilityMetrics.responsibilityId, seeded.id));
      expect(pending.filter((metric) => metric.position !== 0)).toHaveLength(0);

      const accepted = await accept({ keepMetrics: [1] });
      expect(accepted.status).toBe(200);
      expect(accepted.body.interaction.result).toMatchObject({ outcome: "accepted", droppedMetrics: [SUPPORTING[0]!.title] });
      const after = await read(seeded.app, seeded.id);
      expect(after.body.metrics.map((metric: { title: string; display: string; role: string }) => [metric.role, metric.title, metric.display])).toEqual([
        ["primary", "Investors contacted", "line"],
        ["supporting", SUPPORTING[1]!.title, "percent"],
      ]);
      const [logged] = await db.select({ details: activityLog.details }).from(activityLog)
        .where(and(eq(activityLog.companyId, seeded.company.id), eq(activityLog.action, "responsibility.metrics_set")));
      expect(logged!.details).toMatchObject({ metrics: [{ title: SUPPORTING[1]!.title }], droppedMetrics: [SUPPORTING[0]!.title] });

      // Dropping every supporting one still sets the bar and its own metric.
      const next = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({ ...BAR, metricTarget: 30, metrics: SUPPORTING });
      const none = await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${next.body.id}/accept`).send({ keepMetrics: [] });
      expect(none.status).toBe(200);
      const bare = await read(seeded.app, seeded.id);
      expect(bare.body.metrics.map((metric: { role: string; target: number }) => [metric.role, metric.target])).toEqual([["primary", 30]]);
      const guidance = await loadResponsibilityBarGuidance(db, {
        issue: { id: issueId, companyId: seeded.company.id, originKind: "responsibility_bar", originId: seeded.id, assigneeAgentId: seeded.ceo.id },
        agentId: seeded.ceo.id,
      });
      expect(guidance).toContain(`accepted and applied without "${SUPPORTING[0]!.title}" and "${SUPPORTING[1]!.title}" (the person dropped it)`);
      expect(guidance).toContain(`accepted and applied without "${SUPPORTING[0]!.title}" (the person dropped it)`);
    });

    it("leaves the set alone when the bar cannot be applied, or the proposal carries none", async () => {
      const seeded = await seed();
      await request(seeded.app).put(`/api/responsibilities/${seeded.id}/metrics`).send({ metrics: [SUPPORTING[1]] });
      const issueId = await conversation(seeded);
      const agent = createApp(agentActor(seeded.company.id, seeded.ceo.id));
      const proposed = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send({ ...BAR, metrics: [] });
      await db.update(responsibilities).set({ status: "dismissed" }).where(eq(responsibilities.id, seeded.id));
      expect((await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${proposed.body.id}/accept`).send({})).status).toBe(409);
      await db.update(responsibilities).set({ status: "active" }).where(eq(responsibilities.id, seeded.id));
      const titles = async () => (await read(seeded.app, seeded.id)).body.metrics.map((metric: { title: string }) => metric.title);
      expect(await titles()).toContain(SUPPORTING[1]!.title);

      // Without metrics the proposal keeps the supporting ones.
      const plain = await request(agent).post(`/api/issues/${issueId}/bar-proposals`).send(BAR);
      expect(plain.body.payload.metrics).toBeNull();
      expect((await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${plain.body.id}/accept`).send({})).status).toBe(200);
      expect(await titles()).toContain(SUPPORTING[1]!.title);
    });
  });
});

describe("primaryReadings", () => {
  const point = (value: number, at: string) => ({ id: "r", value, recordedAt: at, recordedByAgentId: null, recordedByUserId: null });
  it("adds the bar's own reading when the history does not have it yet", () => {
    expect(primaryReadings({ metricCurrent: 7, metricUpdatedAt: new Date("2026-11-10T00:00:00.000Z") }, []))
      .toEqual([{ id: null, value: 7, recordedAt: "2026-11-10T00:00:00.000Z", recordedByAgentId: null, recordedByUserId: null }]);
    const history = [point(7, "2026-11-10T00:00:00.000Z")];
    expect(primaryReadings({ metricCurrent: 7, metricUpdatedAt: new Date("2026-11-10T00:00:00.000Z") }, history)).toEqual(history);
    expect(primaryReadings({ metricCurrent: null, metricUpdatedAt: null }, [])).toEqual([]);
  });
});
