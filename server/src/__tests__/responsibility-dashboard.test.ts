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
  issueThreadInteractions,
  issues,
  responsibilities,
  responsibilityAreas,
  responsibilityDashboardVersions,
  responsibilityLinks,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_VERSION_LIMIT,
  createDashboardChangeSetSchema,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityDashboardRoutes } from "../routes/responsibility-dashboard.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { responsibilityAreaRoutes } from "../routes/responsibility-areas.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { responsibilityDashboardService } from "../services/responsibility-dashboard.js";
import { loadDashboardConversationGuidance } from "../services/responsibility-dashboard-guidance.js";
import { responsibilityDashboardVersionService } from "../services/responsibility-dashboard-versions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_DASHBOARD_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";
const OTHER = "other-user";

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

describeEmbeddedPostgres("dashboard conversations, change sets and versions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wakeup: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-dashboard-");
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
    app.use("/api", responsibilityAreaRoutes(db));
    app.use("/api", responsibilityDashboardRoutes(db, { heartbeat }));
    app.use(errorHandler);
    return app;
  }

  async function seed(opts: { populated?: boolean } = {}) {
    const company = await db.insert(companies)
      .values({ name: "Dash Co", issuePrefix: `D${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
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
    const seeded = { company, ceo: ceo!, analyst: analyst!, app, areas: {} as Record<string, string>, items: {} as Record<string, string> };
    if (opts.populated) {
      for (const title of ["Fundraising", "Hiring"]) {
        const area = await request(app).post(`/api/companies/${company.id}/responsibility-areas`).send({ title });
        expect(area.status).toBe(201);
        seeded.areas[title] = area.body.id;
      }
      const add = async (key: string, title: string, areaId: string, extra: object = {}) => {
        const created = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title, areaId, ...extra });
        expect(created.status).toBe(201);
        seeded.items[key] = created.body.id;
      };
      await add("lps", "Every LP hears from us every two weeks.", seeded.areas.Fundraising!);
      await add("deck", "The deck is always current.", seeded.areas.Fundraising!);
      await add("pipeline", "Hiring pipeline", seeded.areas.Hiring!, {
        standard: "Every open role has three qualified candidates.", metricName: "Qualified candidates", metricTarget: 3,
      });
    }
    return seeded;
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function actions(companyId: string) {
    return db.select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.companyId, companyId));
  }

  async function start(seeded: Seeded, body: object = { mode: "create" }, app = seeded.app) {
    return request(app).post(`/api/companies/${seeded.company.id}/responsibility-dashboard/conversation`).send(body);
  }

  async function propose(seeded: Seeded, issueId: string, body: object, agentId = seeded.ceo.id) {
    return request(createApp(agentActor(seeded.company.id, agentId))).post(`/api/issues/${issueId}/dashboard-changes`).send(body);
  }

  async function accept(seeded: Seeded, issueId: string, interactionId: string, body: object = {}, app = seeded.app) {
    return request(app).post(`/api/issues/${issueId}/dashboard-changes/${interactionId}/accept`).send(body);
  }

  async function state(seeded: Seeded) {
    return (await request(seeded.app).get(`/api/companies/${seeded.company.id}/responsibility-dashboard`)).body;
  }

  async function versionsOf(seeded: Seeded) {
    return db.select().from(responsibilityDashboardVersions)
      .where(eq(responsibilityDashboardVersions.companyId, seeded.company.id))
      .orderBy(responsibilityDashboardVersions.createdAt);
  }

  async function ownRows(seeded: Seeded) {
    return db.select().from(responsibilities).where(and(eq(responsibilities.companyId, seeded.company.id), eq(responsibilities.ownerUserId, OWNER)));
  }

  async function areaRows(seeded: Seeded) {
    return db.select().from(responsibilityAreas).where(eq(responsibilityAreas.companyId, seeded.company.id));
  }

  /** The dashboard as the person sees it: active areas' names and their active sentences. */
  async function dashboard(seeded: Seeded) {
    const [items, areas] = await Promise.all([ownRows(seeded), areaRows(seeded)]);
    const out: Record<string, string[]> = {};
    for (const item of items.filter((row) => row.status === "active")) {
      const area = areas.find((row) => row.id === item.areaId);
      const key = area ? `${area.title}${area.status === "archived" ? " (archived)" : ""}` : "No area";
      (out[key] ??= []).push(item.standard?.trim() || item.title);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  }

  const FIRST_DASHBOARD = {
    message: "A first dashboard from your answers.",
    changes: [
      { op: "add_area", ref: "fund", name: "Fundraising" },
      { op: "add_responsibility", areaRef: "fund", sentence: "Every LP hears from us every two weeks.", reason: "You run the LP sync." },
      { op: "add_responsibility", areaRef: "fund", sentence: "The data room is always current." },
      { op: "add_area", ref: "people", name: "People" },
      { op: "add_responsibility", areaRef: "people", sentence: "Every open role has a hiring plan." },
    ],
  };

  async function createFirstDashboard(seeded: Seeded) {
    const issueId = (await start(seeded)).body.conversation.issueId as string;
    const proposed = await propose(seeded, issueId, FIRST_DASHBOARD);
    expect(proposed.status).toBe(201);
    const applied = await accept(seeded, issueId, proposed.body.id);
    expect(applied.status).toBe(200);
    return { issueId, interaction: proposed.body, applied: applied.body };
  }

  describe("reads", () => {
    it("counts a dashboard as empty only with nothing active and nothing proposed", async () => {
      const seeded = await seed();
      expect(await state(seeded)).toMatchObject({ ownerUserId: OWNER, empty: true, state: "none", defaultAgentId: seeded.ceo.id, conversation: null, proposal: null, latestChange: null });
      const [let_go] = await db.insert(responsibilities).values({ companyId: seeded.company.id, ownerUserId: OWNER, title: "Old", status: "let_go" }).returning();
      expect((await state(seeded)).empty).toBe(true);
      await db.update(responsibilities).set({ status: "proposed" }).where(eq(responsibilities.id, let_go!.id));
      expect((await state(seeded)).empty).toBe(false);
      await db.update(responsibilities).set({ status: "active" }).where(eq(responsibilities.id, let_go!.id));
      expect((await state(seeded)).empty).toBe(false);
      // Someone else's responsibilities do not make it populated.
      const other = await seed();
      await db.insert(responsibilities).values({ companyId: other.company.id, ownerUserId: OTHER, title: "Theirs", status: "active" });
      expect((await state(other)).empty).toBe(true);
    });

    it("follows the overview's access rules, is off with the flag, and reads in a fixed number of queries", async () => {
      const seeded = await seed({ populated: true });
      const url = `/api/companies/${seeded.company.id}/responsibility-dashboard`;
      const agentApp = createApp(agentActor(seeded.company.id, seeded.analyst.id));
      expect((await request(agentApp).get(url)).status).toBe(422);
      expect((await request(agentApp).get(`${url}?ownerUserId=${OWNER}`)).status).toBe(200);
      expect((await request(agentApp).get(`${url}/versions?ownerUserId=${OWNER}`)).status).toBe(200);
      expect((await request(createApp(agentActor(randomUUID(), seeded.analyst.id))).get(`${url}?ownerUserId=${OWNER}`)).status).toBe(403);
      // An agent's read never saves a version.
      expect(await versionsOf(seeded)).toHaveLength(0);

      const count = async (read: (database: Db) => Promise<unknown>) => {
        const queries: string[] = [];
        const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: (query) => queries.push(query) } }) as unknown as Db;
        await read(recorded);
        return queries.length;
      };
      const stateQueries = async (s: Seeded) => count((database) => responsibilityDashboardService(database).state(s.company.id, OWNER));
      const listQueries = async (s: Seeded) => count((database) => responsibilityDashboardVersionService(database).list(s.company.id, OWNER));
      const empty = await seed();
      const [idle, fresh] = [await stateQueries(seeded), await stateQueries(empty)];
      expect(idle).toBe(fresh);
      const { issueId } = await createFirstDashboard(empty);
      expect((await propose(empty, issueId, { changes: [{ op: "add_area", ref: "ops", name: "Operations" }] })).status).toBe(201);
      // With a conversation, a proposal waiting and a latest change: two more (the proposal and its card).
      expect(await stateQueries(empty)).toBe(idle + 2);
      expect(await listQueries(seeded)).toBe(await listQueries(empty));

      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      for (const res of [
        await request(seeded.app).get(url),
        await request(seeded.app).get(`${url}/versions`),
        await start(seeded),
        await propose(seeded, issueId, FIRST_DASHBOARD),
        await accept(seeded, issueId, randomUUID()),
        await request(seeded.app).post(`/api/issues/${issueId}/dashboard-changes/${randomUUID()}/decline`).send({}),
        await request(seeded.app).post(`/api/responsibility-dashboard-versions/${randomUUID()}/restore`).send({}),
      ]) {
        expect(res.status).toBe(404);
      }
    });
  });

  describe("the conversation", () => {
    it("starts in create mode with the interview card, waits for the answers, and reopens the same conversation", async () => {
      const seeded = await seed();
      const started = await start(seeded);
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ empty: true, state: "discussing", conversation: { agentId: seeded.ceo.id, mode: "create", title: "Create my dashboard" } });
      const issueId = started.body.conversation.issueId as string;
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task).toMatchObject({
        originKind: RESPONSIBILITY_DASHBOARD_ORIGIN_KIND, originId: OWNER, originFingerprint: "create", assigneeAgentId: seeded.ceo.id, createdByUserId: OWNER, status: "todo",
      });
      expect(task!.description).toContain(`/${seeded.company.issuePrefix}/responsibilities)`);
      const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ kind: "ask_user_questions", createdByAgentId: seeded.ceo.id, continuationPolicy: "wake_assignee" });
      const questions = (cards[0]!.payload as { questions: Array<{ id: string; required?: boolean; options: Array<{ id: string }> }> }).questions;
      expect(questions.map((question) => question.id)).toEqual(["role", "areas", "behind", "avoid", "research-consent"]);
      // The lookup is asked last, optional, with no first: no answer means no.
      const consent = questions.at(-1)!;
      expect(consent.required).toBe(false);
      expect(consent.options.map((option) => option.id)).toEqual(["no", "yes"]);
      // Nothing runs until the person answers.
      expect(wakeup).not.toHaveBeenCalled();
      expect((await actions(seeded.company.id)).map((entry) => entry.action))
        .toEqual(expect.arrayContaining(["issue.created", "responsibility_dashboard.conversation_started"]));

      const again = await start(seeded, { mode: "edit" });
      expect(again.status).toBe(200);
      expect(again.body.conversation).toMatchObject({ issueId, mode: "create" });
      expect(await db.select().from(issues).where(eq(issues.originKind, RESPONSIBILITY_DASHBOARD_ORIGIN_KIND)).then((rows) => rows.filter((row) => row.companyId === seeded.company.id))).toHaveLength(1);
    });

    it("starts in edit mode and wakes the agent, once the earlier conversation is finished", async () => {
      const seeded = await seed({ populated: true });
      const first = await start(seeded, { mode: "edit" });
      expect(first.status).toBe(201);
      expect(first.body.conversation).toMatchObject({ mode: "edit", title: "Edit my dashboard" });
      const issueId = first.body.conversation.issueId as string;
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).toEqual([]);
      expect(wakeup).toHaveBeenCalledWith(seeded.ceo.id, expect.objectContaining({ payload: expect.objectContaining({ issueId }) }));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      expect((await state(seeded)).state).toBe("settled");
      const second = await start(seeded, { mode: "edit", agentId: seeded.analyst.id });
      expect(second.status).toBe(201);
      expect(second.body.conversation).toMatchObject({ agentId: seeded.analyst.id, mode: "edit" });
      expect(second.body.conversation.issueId).not.toBe(issueId);
    });

    it("lets only the person or an admin start it, and says so when no agent can hold it", async () => {
      const seeded = await seed();
      expect((await start(seeded, { mode: "create", ownerUserId: OWNER }, createApp(sessionBoardActor(seeded.company.id, OTHER)))).status).toBe(403);
      expect((await start(seeded, { mode: "create" }, createApp(agentActor(seeded.company.id, seeded.ceo.id)))).status).toBe(403);
      // An admin may start one for someone else; their own dashboard is untouched.
      const forOther = await start(seeded, { mode: "create", ownerUserId: OTHER });
      expect(forOther.status).toBe(201);
      expect(forOther.body.ownerUserId).toBe(OTHER);
      expect((await start(seeded, { mode: "create", ownerUserId: "stranger" })).status).toBe(404);

      const quiet = await seed();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.companyId, quiet.company.id));
      expect((await state(quiet)).defaultAgentId).toBeNull();
      const refused = await start(quiet);
      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain("responsibility_dashboard_no_agent");
    });

    it("puts the guidance only on the conversation task, for its agent, and words it by mode", async () => {
      const seeded = await seed({ populated: true });
      const createId = (await start(seeded, { mode: "create" })).body.conversation.issueId as string;
      const guidance = async (issueId: string, agentId = seeded.ceo.id) => {
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        return loadDashboardConversationGuidance(db, {
          issue: { id: row!.id, companyId: row!.companyId, originKind: row!.originKind, originId: row!.originId, assigneeAgentId: row!.assigneeAgentId },
          agentId,
        });
      };
      const created = await guidance(createId);
      expect(created).toContain("How to hold the conversation (create):");
      expect(created).toContain("Looking them up on the public web: only when they answered \"Yes, look me up\"");
      expect(created).toContain("No answer, or \"No\", means no");
      expect(created).toContain("If it can be finished, it is a task or a project, not a responsibility");
      expect(created).toContain("five to seven areas");
      expect(created).toContain("Never propose removing something without saying why");
      expect(created).toContain(`Area "Fundraising" (areaId ${seeded.areas.Fundraising})`);
      expect(created).toContain(`"Every open role has three qualified candidates." (responsibilityId ${seeded.items.pipeline})`);
      expect(created).toContain(`POST /api/issues/${createId}/dashboard-changes`);
      expect(await guidance(createId, seeded.analyst.id)).toBeNull();

      await db.update(issues).set({ status: "done" }).where(eq(issues.id, createId));
      const editId = (await start(seeded, { mode: "edit" })).body.conversation.issueId as string;
      const edited = await guidance(editId);
      expect(edited).toContain("How to hold the conversation (edit):");
      expect(edited).not.toContain("How to hold the conversation (create):");
      expect(edited).toContain("Look them up on the public web only if they ask you to in this conversation");

      const [plain] = await db.insert(issues).values({ companyId: seeded.company.id, title: "Plain", status: "todo", priority: "medium", assigneeAgentId: seeded.ceo.id }).returning();
      expect(await guidance(plain!.id)).toBeNull();
      // Never counted as manual work or offered as an automation.
      expect(RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS).toContain(RESPONSIBILITY_DASHBOARD_ORIGIN_KIND);
    });
  });

  describe("proposing a change set", () => {
    it("lets only the conversation's agent propose, and writes nothing", async () => {
      const seeded = await seed();
      const issueId = (await start(seeded)).body.conversation.issueId as string;
      expect((await propose(seeded, issueId, FIRST_DASHBOARD, seeded.analyst.id)).status).toBe(403);
      expect((await request(seeded.app).post(`/api/issues/${issueId}/dashboard-changes`).send(FIRST_DASHBOARD)).status).toBe(403);
      const elsewhere = await seed();
      expect((await request(createApp(agentActor(elsewhere.company.id, elsewhere.ceo.id))).post(`/api/issues/${issueId}/dashboard-changes`).send(FIRST_DASHBOARD)).status).toBe(404);
      const [plain] = await db.insert(issues).values({ companyId: seeded.company.id, title: "Plain", status: "todo", priority: "medium", assigneeAgentId: seeded.ceo.id }).returning();
      expect((await propose(seeded, plain!.id, FIRST_DASHBOARD)).status).toBe(422);

      const res = await propose(seeded, issueId, FIRST_DASHBOARD);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: "propose_dashboard_changes", status: "pending", continuationPolicy: "none", effectiveResolverPolicy: "human_only" });
      const changes = res.body.payload.changes as Array<{ op: string; dependsOn: number[]; groupRef: string | null; groupName: string }>;
      expect(changes.map((change) => [change.op, change.dependsOn, change.groupName])).toEqual([
        ["add_area", [], "Fundraising"],
        ["add_responsibility", [0], "Fundraising"],
        ["add_responsibility", [0], "Fundraising"],
        ["add_area", [], "People"],
        ["add_responsibility", [3], "People"],
      ]);
      expect(await ownRows(seeded)).toEqual([]);
      expect(await areaRows(seeded)).toEqual([]);
      expect((await state(seeded)).state).toBe("proposal_waiting");

      // A new proposal replaces the waiting one.
      const second = await propose(seeded, issueId, { changes: [FIRST_DASHBOARD.changes[0]] });
      const [first] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, res.body.id));
      expect(first).toMatchObject({ status: "expired", result: { outcome: "replaced", replacedByInteractionId: second.body.id } });
    });

    it("validates each kind of change against the dashboard", async () => {
      const seeded = await seed({ populated: true });
      const issueId = (await start(seeded, { mode: "edit" })).body.conversation.issueId as string;
      const [archived] = await db.insert(responsibilityAreas).values({ companyId: seeded.company.id, title: "Old area", status: "archived" }).returning();
      const [theirs] = await db.insert(responsibilities).values({ companyId: seeded.company.id, ownerUserId: OTHER, title: "Theirs", status: "active", areaId: seeded.areas.Hiring }).returning();
      const fails = async (changes: object[], status: number, words?: string) => {
        const res = await propose(seeded, issueId, { changes });
        expect(res.status, JSON.stringify(changes)).toBe(status);
        if (words) expect(JSON.stringify(res.body)).toContain(words);
      };
      const { Fundraising: fund, Hiring: hiring } = seeded.areas;
      const { lps, deck } = seeded.items;
      // Shape (400).
      await fails([{ op: "remove_area", areaId: fund }], 400, "reason");
      await fails([{ op: "remove_responsibility", responsibilityId: lps }], 400, "reason");
      await fails([{ op: "add_responsibility", areaRef: "nope", sentence: "Something holds." }], 400, "No add_area earlier in this list");
      await fails([{ op: "add_responsibility", areaId: fund, areaRef: "x", sentence: "Something holds." }, { op: "add_area", ref: "x", name: "X" }], 400, "exactly one of areaId");
      await fails([{ op: "add_area", ref: "a", name: "Ops" }, { op: "add_area", ref: "a", name: "Legal" }], 400, "ref");
      await fails([{ op: "reword_responsibility", responsibilityId: lps, sentence: "New words." }, { op: "remove_responsibility", responsibilityId: lps, reason: "Done" }], 400, "removed cannot also");
      await fails([{ op: "rename_area", areaId: fund, name: "Capital" }, { op: "remove_area", areaId: fund, reason: "Done" }], 400, "renamed and removed");
      await fails([{ op: "remove_area", areaId: fund, reason: "Done" }, { op: "add_responsibility", areaId: fund, sentence: "Something holds." }], 400, "cannot also receive");
      await fails([{ op: "add_responsibility", areaId: fund, sentence: "x".repeat(201) }], 400);
      // Against the data (422).
      await fails([{ op: "add_responsibility", areaId: randomUUID(), sentence: "Something holds." }], 422, "No area with that areaId");
      await fails([{ op: "add_responsibility", areaId: archived!.id, sentence: "Something holds." }], 422, "is archived");
      await fails([{ op: "add_area", ref: "f", name: "fundraising" }], 422, "already exists");
      await fails([{ op: "rename_area", areaId: fund, name: "Hiring" }], 422, "already called");
      await fails([{ op: "rename_area", areaId: fund, name: "Fundraising" }], 422, "already has that name");
      await fails([{ op: "remove_area", areaId: hiring, reason: "Not yours" }], 422, "another person");
      await fails([{ op: "reword_responsibility", responsibilityId: theirs!.id, sentence: "Mine now." }], 422, "not one of this person's");
      await fails([{ op: "reword_responsibility", responsibilityId: deck, sentence: "The deck is always current." }], 422, "same as the one it has");
      await fails([{ op: "move_responsibility", responsibilityId: deck, areaId: fund }], 422, "already in that area");
      await fails([{ op: "add_responsibility", areaId: hiring, sentence: "The deck is always current." }], 422, "reads exactly like this");
      // A rename of a shared area says who else sees it.
      const shared = await propose(seeded, issueId, { changes: [{ op: "rename_area", areaId: hiring, name: "Recruiting" }] });
      expect(shared.status).toBe(201);
      expect(shared.body.payload.changes[0]).toMatchObject({ fromName: "Hiring", name: "Recruiting", sharedWith: 1 });
      // A removed area lists what goes with it, minus what is moved out.
      const removal = await propose(seeded, issueId, {
        changes: [
          { op: "add_area", ref: "ir", name: "Investor relations" },
          { op: "move_responsibility", responsibilityId: lps, areaRef: "ir" },
          { op: "remove_area", areaId: fund, reason: "Fundraising is finished; what remains is investor relations." },
        ],
      });
      expect(removal.status).toBe(201);
      expect(removal.body.payload.changes[2]).toMatchObject({ lettingGo: [{ id: deck, sentence: "The deck is always current." }] });
      expect(removal.body.payload.changes[1]).toMatchObject({ dependsOn: [0], fromAreaName: "Fundraising", groupName: "Investor relations" });
      expect(createDashboardChangeSetSchema.safeParse({ changes: [] }).success).toBe(false);
    });
  });

  describe("applying", () => {
    it("applies a first dashboard: sentence-only, active responsibilities in new areas, with versions before and after", async () => {
      const seeded = await seed();
      const { applied, issueId } = await createFirstDashboard(seeded);
      expect(applied.interaction).toMatchObject({ status: "accepted", result: { outcome: "accepted", summary: "Added 2 areas and 3 responsibilities" } });
      expect(applied.version).toMatchObject({ cause: "change_set", summary: "Added 2 areas and 3 responsibilities", actorAgentId: seeded.ceo.id, actorUserId: OWNER });
      expect(await dashboard(seeded)).toEqual({
        Fundraising: ["Every LP hears from us every two weeks.", "The data room is always current."],
        People: ["Every open role has a hiring plan."],
      });
      const rows = await ownRows(seeded);
      for (const row of rows) {
        expect(row).toMatchObject({ status: "active", source: "manual", standard: null, metricName: null, metricKind: null, metricDirection: null, proposedByAgentId: seeded.ceo.id });
        expect(row.confirmedAt).not.toBeNull();
      }
      const saved = await versionsOf(seeded);
      expect(saved.map((row) => [row.cause, row.summary])).toEqual([["person", "Empty"], ["change_set", "Added 2 areas and 3 responsibilities"]]);
      expect(saved[1]!.previousVersionId).toBe(saved[0]!.id);
      expect(applied.interaction.result.previousVersionId).toBe(saved[0]!.id);
      expect(await state(seeded)).toMatchObject({ empty: false, state: "settled", latestChange: { id: saved[1]!.id, previousVersionId: saved[0]!.id } });
      const logged = (await actions(seeded.company.id)).map((entry) => entry.action);
      expect(logged.filter((action) => action === "responsibility.created")).toHaveLength(3);
      expect(logged.filter((action) => action === "responsibility_area.created")).toHaveLength(2);
      expect(logged).toEqual(expect.arrayContaining(["responsibility_dashboard.changes_applied", "issue.thread_interaction_accepted"]));
      // Only the person or an admin applies.
      const next = await propose(seeded, issueId, { changes: [{ op: "add_area", ref: "x", name: "Ops" }] });
      expect((await accept(seeded, issueId, next.body.id, {}, createApp(sessionBoardActor(seeded.company.id, OTHER)))).status).toBe(403);
      expect((await accept(seeded, issueId, next.body.id, {}, createApp(agentActor(seeded.company.id, seeded.ceo.id)))).status).toBe(403);
    });

    it("lets the person drop changes, refuses a kept change whose new area was dropped, and records what was dropped", async () => {
      const seeded = await seed();
      const issueId = (await start(seeded)).body.conversation.issueId as string;
      const proposed = await propose(seeded, issueId, FIRST_DASHBOARD);
      const broken = await accept(seeded, issueId, proposed.body.id, { keep: [1, 2, 3, 4] });
      expect(broken.status).toBe(422);
      expect(JSON.stringify(broken.body)).toContain("responsibility_dashboard_keep_dependency");
      expect((await accept(seeded, issueId, proposed.body.id, { keep: [9] })).status).toBe(422);
      expect((await accept(seeded, issueId, proposed.body.id, { keep: [] })).status).toBe(400);
      expect(await ownRows(seeded)).toEqual([]);
      const partial = await accept(seeded, issueId, proposed.body.id, { keep: [0, 1, 3] });
      expect(partial.status).toBe(200);
      expect(partial.body.interaction.result).toMatchObject({ dropped: [2, 4] });
      expect(await dashboard(seeded)).toEqual({ Fundraising: ["Every LP hears from us every two weeks."] });
      // The empty new area is still on the dashboard, so it is part of the version.
      const after = await versionsOf(seeded);
      expect((after.at(-1)!.snapshot as { areas: Array<{ title: string }> }).areas.map((area) => area.title).sort()).toEqual(["Fundraising", "People"]);
    });

    it("lets go and archives instead of deleting, and keeps what is filed underneath", async () => {
      const seeded = await seed({ populated: true });
      const [task] = await db.insert(issues).values({ companyId: seeded.company.id, title: "Update deck", status: "todo", priority: "medium" }).returning();
      await db.insert(responsibilityLinks).values({ companyId: seeded.company.id, responsibilityId: seeded.items.deck!, issueId: task!.id });
      const issueId = (await start(seeded, { mode: "edit" })).body.conversation.issueId as string;
      const proposed = await propose(seeded, issueId, {
        changes: [
          { op: "add_area", ref: "ir", name: "Investor relations" },
          { op: "move_responsibility", responsibilityId: seeded.items.lps, areaRef: "ir" },
          { op: "reword_responsibility", responsibilityId: seeded.items.pipeline, sentence: "Every open role has two strong candidates.", reason: "Three is more than you need." },
          { op: "remove_area", areaId: seeded.areas.Fundraising, reason: "The raise is done." },
        ],
      });
      expect(proposed.status).toBe(201);
      const applied = await accept(seeded, issueId, proposed.body.id);
      expect(applied.status).toBe(200);
      expect(await dashboard(seeded)).toEqual({
        "Investor relations": ["Every LP hears from us every two weeks."],
        Hiring: ["Every open role has two strong candidates."],
      });
      const rows = await ownRows(seeded);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === seeded.items.deck)).toMatchObject({ status: "let_go" });
      // A bar keeps its metric; the sentence the Dashboard shows (its bar sentence) is what is reworded.
      expect(rows.find((row) => row.id === seeded.items.pipeline)).toMatchObject({ title: "Hiring pipeline", standard: "Every open role has two strong candidates.", metricName: "Qualified candidates", metricTarget: 3 });
      expect((await areaRows(seeded)).find((row) => row.id === seeded.areas.Fundraising)).toMatchObject({ status: "archived" });
      expect(await db.select().from(responsibilityLinks).where(eq(responsibilityLinks.issueId, task!.id))).toHaveLength(1);
    });

    it("is atomic: a change that no longer fits fails the whole apply and leaves the card waiting", async () => {
      const seeded = await seed({ populated: true });
      const issueId = (await start(seeded, { mode: "edit" })).body.conversation.issueId as string;
      const proposed = await propose(seeded, issueId, {
        changes: [
          { op: "add_responsibility", areaId: seeded.areas.Hiring, sentence: "Offers go out within a week." },
          { op: "remove_area", areaId: seeded.areas.Fundraising, reason: "The raise is done." },
        ],
      });
      // Someone else files a responsibility in Fundraising meanwhile.
      await db.insert(responsibilities).values({ companyId: seeded.company.id, ownerUserId: OTHER, title: "Theirs", status: "active", areaId: seeded.areas.Fundraising });
      const before = await dashboard(seeded);
      const refused = await accept(seeded, issueId, proposed.body.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("Someone else now has responsibilities in \"Fundraising\"");
      expect(await dashboard(seeded)).toEqual(before);
      expect(await versionsOf(seeded)).toHaveLength(0);
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, proposed.body.id));
      expect(card!.status).toBe("pending");
    });

    it("declines quietly: the card closes and nothing changes", async () => {
      const seeded = await seed();
      const issueId = (await start(seeded)).body.conversation.issueId as string;
      const proposed = await propose(seeded, issueId, FIRST_DASHBOARD);
      const declined = await request(seeded.app).post(`/api/issues/${issueId}/dashboard-changes/${proposed.body.id}/decline`).send({});
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({ status: "rejected", result: { outcome: "declined" } });
      expect(await ownRows(seeded)).toEqual([]);
      expect((await state(seeded)).state).toBe("discussing");
    });
  });

  describe("versions and restore", () => {
    it("undoes a change set, and undoes the undo", async () => {
      const seeded = await seed();
      const { applied } = await createFirstDashboard(seeded);
      const created = await dashboard(seeded);
      const undo = await request(seeded.app).post(`/api/responsibility-dashboard-versions/${applied.interaction.result.previousVersionId}/restore`).send({});
      expect(undo.status).toBe(200);
      expect(undo.body.version).toMatchObject({ cause: "restore", summary: "Removed 2 areas and let go of 3 responsibilities" });
      expect(await dashboard(seeded)).toEqual({});
      expect((await ownRows(seeded)).every((row) => row.status === "let_go")).toBe(true);
      expect((await areaRows(seeded)).every((row) => row.status === "archived")).toBe(true);
      expect(await state(seeded)).toMatchObject({ empty: true, latestChange: { cause: "restore", previousVersionId: applied.version.id } });

      const redo = await request(seeded.app).post(`/api/responsibility-dashboard-versions/${undo.body.version.previousVersionId}/restore`).send({});
      expect(redo.status).toBe(200);
      expect(await dashboard(seeded)).toEqual(created);
      // The same rows came back, not copies.
      expect(await ownRows(seeded)).toHaveLength(3);
      expect(await areaRows(seeded)).toHaveLength(2);
      const logged = (await actions(seeded.company.id)).map((entry) => entry.action);
      expect(logged.filter((action) => action === "responsibility_dashboard.restored")).toHaveLength(2);
      // Restoring the version it already matches changes nothing and saves nothing.
      const count = (await versionsOf(seeded)).length;
      const same = await request(seeded.app).post(`/api/responsibility-dashboard-versions/${redo.body.version.id}/restore`).send({});
      expect(same.status).toBe(200);
      expect(await versionsOf(seeded)).toHaveLength(count);
    });

    it("can undo removing an empty area made by hand", async () => {
      const seeded = await seed({ populated: true });
      const legal = await request(seeded.app).post(`/api/companies/${seeded.company.id}/responsibility-areas`).send({ title: "Legal" });
      expect(legal.status).toBe(201);
      const issueId = (await start(seeded, { mode: "edit" })).body.conversation.issueId as string;
      const proposed = await propose(seeded, issueId, { changes: [{ op: "remove_area", areaId: legal.body.id, reason: "Nothing is filed there." }] });
      expect(proposed.status).toBe(201);
      const applied = await accept(seeded, issueId, proposed.body.id);
      expect(applied.status).toBe(200);
      const result = applied.body.interaction.result;
      expect(result.versionId).not.toBe(result.previousVersionId);
      expect(result.summary).not.toBe("No changes");
      expect((await areaRows(seeded)).find((row) => row.id === legal.body.id)).toMatchObject({ status: "archived" });
      const undo = await request(seeded.app).post(`/api/responsibility-dashboard-versions/${result.previousVersionId}/restore`).send({});
      expect(undo.status).toBe(200);
      expect((await areaRows(seeded)).find((row) => row.id === legal.body.id)).toMatchObject({ title: "Legal", status: "active" });
    });

    it("picks up changes made by hand before the next change, and when the list is opened, without duplicates", async () => {
      const seeded = await seed();
      const { issueId } = await createFirstDashboard(seeded);
      const list = async () => (await request(seeded.app).get(`/api/companies/${seeded.company.id}/responsibility-dashboard/versions`)).body;
      expect((await list()).versions).toHaveLength(2);
      expect((await list()).versions).toHaveLength(2);
      const area = (await areaRows(seeded)).find((row) => row.title === "People")!;
      await request(seeded.app).post(`/api/companies/${seeded.company.id}/responsibilities`).send({ title: "Onboarding takes a week.", areaId: area.id });
      const opened = await list();
      expect(opened.versions).toHaveLength(3);
      expect(opened.versions[0]).toMatchObject({ cause: "person", summary: "Added 1 responsibility", actorUserId: OWNER });
      expect((await actions(seeded.company.id)).map((entry) => entry.action)).toContain("responsibility_dashboard.version_saved");

      // A hand edit right before an agent change is saved first, so Undo goes back to it.
      const lps = (await ownRows(seeded)).find((row) => row.title.startsWith("Every LP"))!;
      await request(seeded.app).patch(`/api/responsibilities/${lps.id}`).send({ title: "Every LP hears from us weekly." });
      const proposed = await propose(seeded, issueId, { changes: [{ op: "add_responsibility", areaId: area.id, sentence: "Every hire has a buddy." }] });
      const applied = await accept(seeded, issueId, proposed.body.id);
      const saved = await versionsOf(seeded);
      expect(saved.map((row) => row.cause)).toEqual(["person", "change_set", "person", "person", "change_set"]);
      expect(saved.at(-2)!.summary).toBe("Reworded 1 responsibility");
      expect(applied.body.interaction.result.previousVersionId).toBe(saved.at(-2)!.id);
      await request(seeded.app).post(`/api/responsibility-dashboard-versions/${saved.at(-2)!.id}/restore`).send({});
      const items = await ownRows(seeded);
      expect(items.find((row) => row.id === lps.id)).toMatchObject({ title: "Every LP hears from us weekly.", status: "active" });
      expect(items.find((row) => row.title === "Every hire has a buddy.")).toMatchObject({ status: "let_go" });
    });

    it("keeps the newest versions only", async () => {
      const seeded = await seed();
      const svc = responsibilityDashboardVersionService(db);
      for (let index = 0; index < RESPONSIBILITY_DASHBOARD_VERSION_LIMIT + 4; index += 1) {
        await db.insert(responsibilities).values({ companyId: seeded.company.id, ownerUserId: OWNER, title: `Item ${index}`, status: "active" });
        await db.transaction((tx) => svc.checkpoint(tx, seeded.company.id, OWNER, OWNER));
      }
      const saved = await versionsOf(seeded);
      expect(saved).toHaveLength(RESPONSIBILITY_DASHBOARD_VERSION_LIMIT);
      expect(saved.at(-1)!.summary).toBe("Added 1 responsibility");
      expect((await request(seeded.app).get(`/api/companies/${seeded.company.id}/responsibility-dashboard/versions`)).body.versions).toHaveLength(RESPONSIBILITY_DASHBOARD_VERSION_LIMIT);
    });

    it("brings back a responsibility and an area deleted since, and uses the live area that now holds an old name", async () => {
      const seeded = await seed({ populated: true });
      const svc = responsibilityDashboardVersionService(db);
      const first = await db.transaction((tx) => svc.checkpoint(tx, seeded.company.id, OWNER, OWNER));
      // Deleted by hand: the deck responsibility and the whole Fundraising area.
      await request(seeded.app).delete(`/api/responsibilities/${seeded.items.deck}`);
      await request(seeded.app).delete(`/api/responsibility-areas/${seeded.areas.Fundraising}`);
      // Hiring is renamed, and a new area takes its old name.
      await request(seeded.app).patch(`/api/responsibility-areas/${seeded.areas.Hiring}`).send({ title: "Talent" });
      const newHiring = await request(seeded.app).post(`/api/companies/${seeded.company.id}/responsibility-areas`).send({ title: "Hiring" });
      const restored = await request(seeded.app).post(`/api/responsibility-dashboard-versions/${first.row.id}/restore`).send({});
      expect(restored.status).toBe(200);
      const rows = await ownRows(seeded);
      const areas = await areaRows(seeded);
      const fundraising = areas.filter((row) => row.title === "Fundraising");
      expect(fundraising).toHaveLength(1);
      expect(fundraising[0]!.id).not.toBe(seeded.areas.Fundraising);
      const deck = rows.find((row) => row.title === "The deck is always current.")!;
      expect(deck).toMatchObject({ status: "active", areaId: fundraising[0]!.id });
      expect(deck.id).toBe(seeded.items.deck);
      expect(rows.find((row) => row.id === seeded.items.lps)).toMatchObject({ areaId: fundraising[0]!.id });
      // Restoring the same version again keeps that responsibility rather than making another copy.
      expect((await request(seeded.app).post(`/api/responsibility-dashboard-versions/${first.row.id}/restore`).send({})).status).toBe(200);
      const decks = (await ownRows(seeded)).filter((row) => row.title === "The deck is always current.");
      expect(decks.map((row) => [row.id, row.status])).toEqual([[seeded.items.deck, "active"]]);
      // Its old name is now another area's: the pipeline goes there and "Talent" keeps its name.
      expect(rows.find((row) => row.id === seeded.items.pipeline)).toMatchObject({ areaId: newHiring.body.id, metricName: "Qualified candidates", standard: "Every open role has three qualified candidates." });
      expect(areas.find((row) => row.id === seeded.areas.Hiring)).toMatchObject({ title: "Talent", status: "archived" });
    });

    it("leaves a shared area's name and order alone, and never archives what someone else still uses", async () => {
      const seeded = await seed({ populated: true });
      await db.insert(responsibilities).values({ companyId: seeded.company.id, ownerUserId: OTHER, title: "Theirs", status: "active", areaId: seeded.areas.Hiring });
      const svc = responsibilityDashboardVersionService(db);
      const first = await db.transaction((tx) => svc.checkpoint(tx, seeded.company.id, OWNER, OWNER));
      await request(seeded.app).patch(`/api/responsibility-areas/${seeded.areas.Hiring}`).send({ title: "Recruiting", sortOrder: 5 });
      await request(seeded.app).patch(`/api/responsibility-areas/${seeded.areas.Fundraising}`).send({ title: "Capital" });
      // Moving the pipeline out of Hiring by hand, then restoring: Hiring is shared, so only the pipeline moves back.
      await request(seeded.app).patch(`/api/responsibilities/${seeded.items.pipeline}`).send({ areaId: seeded.areas.Fundraising });
      await request(seeded.app).post(`/api/responsibility-dashboard-versions/${first.row.id}/restore`).send({});
      const areas = await areaRows(seeded);
      expect(areas.find((row) => row.id === seeded.areas.Hiring)).toMatchObject({ title: "Recruiting", sortOrder: 5, status: "active" });
      expect(areas.find((row) => row.id === seeded.areas.Fundraising)).toMatchObject({ title: "Fundraising" });
      expect((await ownRows(seeded)).find((row) => row.id === seeded.items.pipeline)).toMatchObject({ areaId: seeded.areas.Hiring });

      // Restoring an empty version lets go of everything this person owns, and archives only what nobody else uses.
      const blank = await db.transaction(async (tx) => svc.save(tx, {
        companyId: seeded.company.id, ownerUserId: OWNER, cause: "person", snapshot: { version: 1, areas: [], responsibilities: [], createdAreaIds: [] },
      }));
      await request(seeded.app).post(`/api/responsibility-dashboard-versions/${blank.row.id}/restore`).send({});
      const after = await areaRows(seeded);
      expect(after.find((row) => row.id === seeded.areas.Hiring)).toMatchObject({ status: "active" });
      expect(after.find((row) => row.id === seeded.areas.Fundraising)).toMatchObject({ status: "archived" });
      expect((await ownRows(seeded)).every((row) => row.status === "let_go")).toBe(true);
      expect(await db.select().from(responsibilities).where(eq(responsibilities.ownerUserId, OTHER)).then((rows) => rows.filter((row) => row.companyId === seeded.company.id).map((row) => row.status))).toEqual(["active"]);
    });

    it("lets only the person or an admin restore", async () => {
      const seeded = await seed();
      const { applied } = await createFirstDashboard(seeded);
      const url = `/api/responsibility-dashboard-versions/${applied.version.id}/restore`;
      expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER))).post(url).send({})).status).toBe(403);
      expect((await request(createApp(agentActor(seeded.company.id, seeded.ceo.id))).post(url).send({})).status).toBe(403);
      expect((await request(createApp(sessionBoardActor(randomUUID(), OWNER))).post(url).send({})).status).toBe(404);
      expect((await request(seeded.app).post(`/api/responsibility-dashboard-versions/${randomUUID()}/restore`).send({})).status).toBe(404);
    });
  });
});
