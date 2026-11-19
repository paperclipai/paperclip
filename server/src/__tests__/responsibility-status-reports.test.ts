import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  projects,
  responsibilityLinks,
  responsibilityStatusReports,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { responsibilityStatusReportRoutes } from "../routes/responsibility-status-reports.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import { responsibilityStatusReportService } from "../services/responsibility-status-reports.js";
import { loadStatusRefreshReminder, loadStatusUpdateGuidance } from "../services/responsibility-status-guidance.js";
import { routineService } from "../services/routines.js";
import { routineSuggestionService } from "../services/routine-suggestions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_STATUS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "status-owner";
const OTHER = "status-other";
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

const REPORT = { status: "at_risk", message: "Drifted from 2.1 s to 2.4 s as the catalogue grew." };

describeEmbeddedPostgres("agent-written responsibility status", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wakeup: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-status-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    wakeup = vi.fn(async () => ({ queued: true }));
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    const heartbeat: IssueAssignmentWakeupDeps = { wakeup: wakeup as unknown as IssueAssignmentWakeupDeps["wakeup"] };
    app.use("/api", responsibilityRoutes(db, { heartbeat }));
    app.use("/api", responsibilityStatusReportRoutes(db, { heartbeat }));
    app.use(errorHandler);
    return app;
  }

  let issueNumber = 1;
  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Status Co", issuePrefix: `S${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: company.id, principalType: "user", principalId: OTHER, status: "active", membershipRole: "operator" },
    ]);
    const [ceo, builder, analyst, lead] = await db.insert(agents).values([
      { companyId: company.id, name: "Chief", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Builder", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Analyst", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Lead", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} },
    ]).returning();
    await db.update(agents).set({ reportsTo: ceo!.id }).where(and(eq(agents.companyId, company.id), eq(agents.role, "engineer")));
    const app = createApp(localBoardActor());
    const created = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({
      title: "Site performance", standard: "Product pages load in under 2 seconds", metricName: "LCP p75", metricUnit: "s",
      metricTarget: 2, metricDirection: "at_most", metricCurrent: 2.4,
    });
    expect(created.status).toBe(201);
    return { company, ceo: ceo!, builder: builder!, analyst: analyst!, lead: lead!, app, responsibility: created.body as { id: string } };
  }

  async function task(companyId: string, values: Partial<typeof issues.$inferInsert>) {
    const [row] = await db.insert(issues).values({ companyId, title: "Work", status: "todo", issueNumber: issueNumber++, ...values }).returning();
    return row!;
  }

  async function fileTask(seeded: Awaited<ReturnType<typeof seed>>, values: Partial<typeof issues.$inferInsert>) {
    const row = await task(seeded.company.id, values);
    await db.insert(responsibilityLinks).values({ companyId: seeded.company.id, responsibilityId: seeded.responsibility.id, issueId: row.id });
    return row;
  }

  const read = (seeded: Awaited<ReturnType<typeof seed>>) =>
    request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/status-report`);
  const write = (seeded: Awaited<ReturnType<typeof seed>>, actor: Actor, body: object = REPORT) =>
    request(createApp(actor)).post(`/api/responsibilities/${seeded.responsibility.id}/status-report`).send(body);

  describe("the reporter", () => {
    it("is the organization's top agent while nobody works under it, then the agent doing the most there", async () => {
      const seeded = await seed();
      expect((await read(seeded)).body).toMatchObject({ current: null, reporterAgentId: seeded.ceo.id, updateRequested: false, history: [] });

      await fileTask(seeded, { assigneeAgentId: seeded.analyst.id });
      expect((await read(seeded)).body.reporterAgentId).toBe(seeded.analyst.id);

      // Two open tasks beat one; a finished task does not count.
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id });
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id });
      await fileTask(seeded, { assigneeAgentId: seeded.analyst.id, status: "done" });
      expect((await read(seeded)).body.reporterAgentId).toBe(seeded.builder.id);

      // Through a linked project: leading it and its tasks count.
      const [project] = await db.insert(projects).values({ companyId: seeded.company.id, name: "Image pipeline", status: "in_progress", leadAgentId: seeded.lead.id }).returning();
      await db.insert(responsibilityLinks).values({ companyId: seeded.company.id, responsibilityId: seeded.responsibility.id, projectId: project!.id });
      await task(seeded.company.id, { assigneeAgentId: seeded.lead.id, projectId: project!.id });
      await task(seeded.company.id, { assigneeAgentId: seeded.lead.id, projectId: project!.id });
      expect((await read(seeded)).body.reporterAgentId).toBe(seeded.lead.id);

      // A paused agent is never asked.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.lead.id));
      expect((await read(seeded)).body.reporterAgentId).toBe(seeded.builder.id);
    });
  });

  describe("who may write", () => {
    it("lets the reporter, an agent working under it, the owner and a company admin write, records who did, and refuses everyone else", async () => {
      const seeded = await seed();
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id });
      await fileTask(seeded, { assigneeAgentId: seeded.analyst.id, status: "done" });

      const byReporter = await write(seeded, agentActor(seeded.company.id, seeded.builder.id), { ...REPORT, detail: "The image pipeline is the fix." });
      expect(byReporter.status).toBe(201);
      expect(byReporter.body.current).toMatchObject({ status: "at_risk", message: REPORT.message, detail: "The image pipeline is the fix.", agentId: seeded.builder.id, userId: null, outOfDate: false });

      // Worked under it (a finished task), though not the reporter.
      const byWorker = await write(seeded, agentActor(seeded.company.id, seeded.analyst.id), { status: "on_track", message: "Back under target after the font cleanup landed." });
      expect(byWorker.status).toBe(201);
      expect(byWorker.body.current.agentId).toBe(seeded.analyst.id);

      // Neither reporter nor working under it.
      expect((await write(seeded, agentActor(seeded.company.id, seeded.lead.id))).status).toBe(403);

      const byOwner = await write(seeded, sessionBoardActor(seeded.company.id, OWNER), { status: "behind", message: "Slipped again after the catalogue import." });
      expect(byOwner.status).toBe(201);
      expect(byOwner.body.current).toMatchObject({ status: "behind", agentId: null, userId: OWNER });

      expect((await write(seeded, sessionBoardActor(seeded.company.id, OTHER))).status).toBe(403);
      expect((await write(seeded, sessionBoardActor(seeded.company.id, OTHER, "admin"))).status).toBe(201);

      // Nobody names the author: the body is strict, and the record follows the caller.
      const forged = await write(seeded, agentActor(seeded.company.id, seeded.builder.id), { ...REPORT, agentId: seeded.ceo.id });
      expect(forged.status).toBe(400);
      const forgedUser = await write(seeded, sessionBoardActor(seeded.company.id, OWNER), { ...REPORT, userId: OTHER });
      expect(forgedUser.status).toBe(400);

      const rows = await db.select().from(responsibilityStatusReports).where(eq(responsibilityStatusReports.responsibilityId, seeded.responsibility.id));
      expect(rows.map((row) => [row.agentId, row.userId]).sort()).toEqual([
        [null, OTHER], [null, OWNER], [seeded.analyst.id, null], [seeded.builder.id, null],
      ].sort());

      const history = (await read(seeded)).body.history as Array<{ userId: string | null }>;
      expect(history).toHaveLength(4);
      expect(history[0]!.userId).toBe(OTHER);

      const logged = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog)
        .where(and(eq(activityLog.companyId, seeded.company.id), eq(activityLog.action, "responsibility.status_reported")));
      expect(logged).toHaveLength(4);
      expect(logged.map((row) => (row.details as { writtenBy: string }).writtenBy).sort()).toEqual(["agent", "agent", "user", "user"]);
    });

    it("checks the message's shape", async () => {
      const seeded = await seed();
      const owner = sessionBoardActor(seeded.company.id, OWNER);
      expect((await write(seeded, owner, { status: "on_track", message: "On track." })).status).toBe(400);
      expect((await write(seeded, owner, { status: "on_track", message: "Fine\nreally" })).status).toBe(400);
      expect((await write(seeded, owner, { status: "on_track", message: "**Twelve** weeks" })).status).toBe(400);
      expect((await write(seeded, owner, { status: "on_track", message: "x".repeat(201) })).status).toBe(400);
      expect((await write(seeded, owner, { status: "great", message: "Twelve straight weeks of improvement." })).status).toBe(400);
      expect((await write(seeded, owner, { status: "unknown", message: "No reading since the analytics change; checking the new source." })).status).toBe(201);
    });
  });

  describe("freshness", () => {
    it("marks a report older than seven days out of date and keeps showing it", async () => {
      const seeded = await seed();
      await db.insert(responsibilityStatusReports).values({
        companyId: seeded.company.id, responsibilityId: seeded.responsibility.id, agentId: seeded.ceo.id,
        status: "on_track", message: "Twelve straight weeks of improvement.", createdAt: new Date(Date.now() - 8 * DAY_MS),
      });
      expect((await read(seeded)).body.current).toMatchObject({ status: "on_track", outOfDate: true });
      await db.insert(responsibilityStatusReports).values({
        companyId: seeded.company.id, responsibilityId: seeded.responsibility.id, agentId: seeded.ceo.id,
        status: "on_track", message: "Thirteen straight weeks of improvement.", createdAt: new Date(Date.now() - 6 * DAY_MS),
      });
      expect((await read(seeded)).body.current).toMatchObject({ message: "Thirteen straight weeks of improvement.", outOfDate: false });
    });
  });

  describe("asking for an update", () => {
    it("opens one small task for the reporter, carries its instructions, keeps it out of manual work and automation, and settles when the report arrives", async () => {
      const seeded = await seed();
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id, title: "Convert the catalogue to AVIF" });
      const owner = createApp(sessionBoardActor(seeded.company.id, OWNER));
      const ask = () => request(owner).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({});

      // Someone who may not edit the responsibility cannot ask.
      expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER))).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({})).status).toBe(403);
      expect((await request(createApp(agentActor(seeded.company.id, seeded.builder.id))).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({})).status).toBe(403);

      const first = await ask();
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ updateRequested: true, reporterAgentId: seeded.builder.id });
      const requests = await db.select().from(issues).where(and(eq(issues.companyId, seeded.company.id), eq(issues.originKind, RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND)));
      expect(requests).toHaveLength(1);
      const helper = requests[0]!;
      expect(helper).toMatchObject({ originId: seeded.responsibility.id, assigneeAgentId: seeded.builder.id, createdByUserId: OWNER, status: "todo" });
      expect(wakeup).toHaveBeenCalledTimes(1);

      // Asking again while it is unanswered changes nothing.
      const again = await ask();
      expect(again.status).toBe(200);
      expect(again.body.updateRequested).toBe(true);
      expect(await db.select().from(issues).where(and(eq(issues.companyId, seeded.company.id), eq(issues.originKind, RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND)))).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);

      // Instructions only on that task, only for its agent.
      const guidance = await loadStatusUpdateGuidance(db, {
        issue: { id: helper.id, companyId: helper.companyId, originKind: helper.originKind, originId: helper.originId, assigneeAgentId: helper.assigneeAgentId },
        agentId: seeded.builder.id,
      });
      expect(guidance).toContain("- Title: Site performance");
      expect(guidance).toContain("Product pages load in under 2 seconds");
      expect(guidance).toContain("Convert the catalogue to AVIF");
      expect(guidance).toContain(`POST /api/responsibilities/${seeded.responsibility.id}/status-report`);
      expect(guidance).toContain("then mark this task done");
      expect(await loadStatusUpdateGuidance(db, {
        issue: { id: helper.id, companyId: helper.companyId, originKind: helper.originKind, originId: helper.originId, assigneeAgentId: helper.assigneeAgentId },
        agentId: seeded.analyst.id,
      })).toBeNull();
      const ordinary = await task(seeded.company.id, { assigneeAgentId: seeded.builder.id });
      expect(await loadStatusUpdateGuidance(db, {
        issue: { id: ordinary.id, companyId: ordinary.companyId, originKind: ordinary.originKind, originId: ordinary.originId, assigneeAgentId: ordinary.assigneeAgentId },
        agentId: seeded.builder.id,
      })).toBeNull();
      // The helper task never carries the refresh reminder itself.
      expect(await loadStatusRefreshReminder(db, {
        issue: { id: helper.id, companyId: helper.companyId, projectId: null, originKind: helper.originKind, assigneeAgentId: helper.assigneeAgentId },
        agentId: seeded.builder.id,
      })).toBeNull();

      // Not manual work, not automatable, not offered as a routine.
      expect(RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS).toContain(RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND);
      const routines = routineService(db);
      const suggestions = routineSuggestionService(db, { routines });
      expect((await suggestions.unrepeatableIssueIds(seeded.company.id, [helper.id, ordinary.id])).has(helper.id)).toBe(true);
      await expect(suggestions.assertCanBeAutomated(helper)).rejects.toMatchObject({ status: 422 });

      // No inbox noise: the owner did not start a conversation by asking.
      const ownerInbox = await issueService(db).list(seeded.company.id, { touchedByUserId: OWNER });
      expect(ownerInbox.map((row: { id: string }) => row.id)).not.toContain(helper.id);

      // The agent reports: the request is answered, and the agent then marks the task done as its prompt says.
      expect((await write(seeded, agentActor(seeded.company.id, seeded.builder.id))).status).toBe(201);
      expect((await read(seeded)).body.updateRequested).toBe(false);
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, helper.id));
      expect((await read(seeded)).body.updateRequested).toBe(false);

      // Asking again after the answer opens a new task.
      expect((await ask()).status).toBe(201);
      expect(wakeup).toHaveBeenCalledTimes(2);

      const logged = await db.select({ action: activityLog.action }).from(activityLog)
        .where(and(eq(activityLog.companyId, seeded.company.id), eq(activityLog.action, "responsibility.status_update_requested")));
      expect(logged).toHaveLength(2);
    });

    it("lists only the work the reporting agent may read in its instructions", async () => {
      const seeded = await seed();
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id, title: "Convert the catalogue to AVIF" });
      const owner = createApp(sessionBoardActor(seeded.company.id, OWNER));
      expect((await request(owner).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({})).status).toBe(201);
      const [helper] = await db.select().from(issues).where(and(eq(issues.companyId, seeded.company.id), eq(issues.originKind, RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND)));
      const privateId = randomUUID();
      await db.insert(issues).values({
        id: privateId, companyId: seeded.company.id, title: "Confidential vendor dispute", status: "todo", priority: "medium",
        visibility: "private", privacyRootIssueId: privateId, responsibleUserId: "someone-else",
      });
      await db.insert(responsibilityLinks).values({ companyId: seeded.company.id, responsibilityId: seeded.responsibility.id, issueId: privateId });
      const guidance = await loadStatusUpdateGuidance(db, {
        issue: { id: helper!.id, companyId: helper!.companyId, originKind: helper!.originKind, originId: helper!.originId, assigneeAgentId: helper!.assigneeAgentId },
        agentId: seeded.builder.id,
      });
      expect(guidance).toContain("Convert the catalogue to AVIF");
      expect(guidance).not.toContain("Confidential vendor dispute");
    });

    it("reminds the reporter, and only the reporter, on other work under the responsibility", async () => {
      const seeded = await seed();
      const mine = await fileTask(seeded, { assigneeAgentId: seeded.builder.id });
      await fileTask(seeded, { assigneeAgentId: seeded.builder.id });
      const theirs = await fileTask(seeded, { assigneeAgentId: seeded.analyst.id });
      const reminder = await loadStatusRefreshReminder(db, {
        issue: { id: mine.id, companyId: mine.companyId, projectId: null, originKind: mine.originKind, assigneeAgentId: mine.assigneeAgentId },
        agentId: seeded.builder.id,
      });
      expect(reminder).toContain("\"Site performance\"");
      expect(reminder).toContain("/status-report");
      expect(await loadStatusRefreshReminder(db, {
        issue: { id: theirs.id, companyId: theirs.companyId, projectId: null, originKind: theirs.originKind, assigneeAgentId: theirs.assigneeAgentId },
        agentId: seeded.analyst.id,
      })).toBeNull();
    });
  });

  describe("the batch read", () => {
    it("reads every active responsibility of the owner in a fixed number of queries", async () => {
      const seeded = await seed();
      const owner = createApp(localBoardActor());
      for (let index = 0; index < 9; index += 1) {
        const created = await request(owner).post(`/api/companies/${seeded.company.id}/responsibilities`).send({
          title: `Extra ${index}`, standard: "Holds", metricName: "Count", metricTarget: 10, metricCurrent: index,
        });
        expect(created.status).toBe(201);
        await db.insert(responsibilityLinks).values({
          companyId: seeded.company.id, responsibilityId: created.body.id,
          issueId: (await task(seeded.company.id, { assigneeAgentId: index % 2 ? seeded.builder.id : seeded.analyst.id })).id,
        });
      }
      await write(seeded, agentActor(seeded.company.id, seeded.ceo.id));
      await request(owner).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({});

      const count = async (companyId: string) => {
        const queries: string[] = [];
        const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: (query) => queries.push(query) } }) as unknown as Db;
        const result = await responsibilityStatusReportService(recorded).overview(companyId, OWNER);
        return { queries: queries.length, result };
      };
      const ten = await count(seeded.company.id);
      expect(ten.result.reports).toHaveLength(10);
      const site = ten.result.reports.find((entry) => entry.responsibilityId === seeded.responsibility.id)!;
      expect(site).toMatchObject({ reporterAgentId: seeded.ceo.id, reporterBasis: "top_agent", current: { status: "at_risk", agentId: seeded.ceo.id } });
      // Written then requested: the request is newer than the report, so it is pending.
      expect(site.updateRequested).toBe(true);
      expect(ten.queries).toBe(7);

      const solo = await seed();
      expect((await count(solo.company.id)).queries).toBe(7);

      const res = await request(owner).get(`/api/companies/${seeded.company.id}/responsibilities/status-reports`);
      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(10);
      expect(res.body.freshDays).toBe(7);
    });

    it("follows the overview's access rules and is off with the flag", async () => {
      const seeded = await seed();
      const url = `/api/companies/${seeded.company.id}/responsibilities/status-reports`;
      const agentRead = await request(createApp(agentActor(seeded.company.id, seeded.builder.id))).get(url);
      expect(agentRead.status).toBe(422);
      expect((await request(createApp(agentActor(seeded.company.id, seeded.builder.id))).get(`${url}?ownerUserId=${OWNER}`)).status).toBe(200);
      expect((await request(createApp(agentActor(randomUUID(), seeded.builder.id))).get(url)).status).toBe(403);

      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      expect((await request(seeded.app).get(url)).status).toBe(404);
      expect((await read(seeded)).status).toBe(404);
      expect((await write(seeded, sessionBoardActor(seeded.company.id, OWNER))).status).toBe(404);
      expect((await request(seeded.app).post(`/api/responsibilities/${seeded.responsibility.id}/status-report/request`).send({})).status).toBe(404);
    });
  });
});
