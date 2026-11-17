import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  projects,
  responsibilities,
  responsibilityLinks,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { ResponsibilityAutomation, ResponsibilityAutomationOverview } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityAutomationRoutes } from "../routes/responsibility-automation.js";
import { routineSuggestionRoutes } from "../routes/routine-suggestions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_AUTOMATION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "automation-owner";
const DAY = 86_400_000;

function boardActor(userId = OWNER): Actor {
  return { type: "board", userId, source: "local_implicit", isInstanceAdmin: true };
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * DAY);
}

describeEmbeddedPostgres("responsibility automation read", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-automation-");
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
    app.use("/api", responsibilityAutomationRoutes(db));
    app.use("/api", routineSuggestionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /**
   * One owner with four active responsibilities, one at each level, plus
   * work that must not count: tasks a routine made (and their subtasks), the
   * onboarding task, a bar conversation, a cancelled task, one finished too
   * long ago, and a paused, an unassigned and an archived routine.
   */
  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Automation Co", issuePrefix: `A${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner",
    });
    const agent = await db.insert(agents).values({
      companyId: company.id, name: "Analyst", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Market watch" }).returning().then((rows) => rows[0]!);

    const [pricing, market, ops, empty, letGo, someoneElse] = await db.insert(responsibilities).values([
      { companyId: company.id, ownerUserId: OWNER, title: "Pricing", status: "active", sortOrder: 0 },
      { companyId: company.id, ownerUserId: OWNER, title: "Market", status: "active", sortOrder: 1 },
      { companyId: company.id, ownerUserId: OWNER, title: "Ops", status: "active", sortOrder: 2 },
      { companyId: company.id, ownerUserId: OWNER, title: "Nothing yet", status: "active", sortOrder: 3 },
      { companyId: company.id, ownerUserId: OWNER, title: "Old", status: "let_go", sortOrder: 4 },
      { companyId: company.id, ownerUserId: "someone-else", title: "Theirs", status: "active", sortOrder: 5 },
    ]).returning();

    const task = (values: Partial<typeof issues.$inferInsert> & { title: string }) =>
      db.insert(issues).values({ companyId: company.id, status: "todo", priority: "medium", ...values })
        .returning().then((rows) => rows[0]!);
    const weekly = await task({ title: "Weekly pricing review", status: "done", assigneeAgentId: agent.id, completedAt: daysAgo(3) });
    const fix = await task({ title: "Fix the checkout button", assigneeUserId: OWNER });
    const longAgo = await task({ title: "Old one-off", status: "done", completedAt: daysAgo(45) });
    const routineMade = await task({ title: "Pricing digest run", originKind: "routine_execution", originId: randomUUID() });
    const routineChild = await task({ title: "Follow-up from the digest", parentId: routineMade.id });
    const onboarding = await task({ title: "Getting to know you", originKind: "onboarding_first_task" });
    const bar = await task({ title: "Talk about the pricing bar", originKind: "responsibility_bar", originId: pricing!.id });
    const cancelled = await task({ title: "Cancelled idea", status: "cancelled" });
    const viaProject = await task({ title: "Competitor scan", status: "done", projectId: project.id, assigneeAgentId: agent.id, completedAt: daysAgo(2) });

    const routine = (values: Partial<typeof routines.$inferInsert> & { title: string }) =>
      db.insert(routines).values({ companyId: company.id, status: "active", ...values }).returning().then((rows) => rows[0]!);
    const running = await routine({ title: "Daily price check", assigneeAgentId: agent.id });
    const paused = await routine({ title: "Monthly discount audit", assigneeAgentId: agent.id, status: "paused" });
    const unassigned = await routine({ title: "Quarterly price list", assigneeAgentId: null });
    const archived = await routine({ title: "Archived thing", assigneeAgentId: agent.id, status: "archived" });
    const projectRoutine = await routine({ title: "Market sweep", assigneeAgentId: agent.id, projectId: project.id });
    const scheduled = await routine({ title: "Ops digest", assigneeAgentId: agent.id, lastTriggeredAt: daysAgo(1) });
    await db.insert(routineTriggers).values({
      companyId: company.id, routineId: scheduled.id, kind: "schedule", label: "Every Monday at 9 AM",
      cronExpression: "0 9 * * 1", timezone: "UTC", nextRunAt: new Date(Date.now() + 2 * DAY),
    });

    const link = (responsibilityId: string, target: { issueId?: string; routineId?: string; projectId?: string }) =>
      ({ companyId: company.id, responsibilityId, ...target });
    await db.insert(responsibilityLinks).values([
      ...[weekly, fix, longAgo, routineMade, routineChild, onboarding, bar, cancelled].map((item) => link(pricing!.id, { issueId: item.id })),
      ...[running, paused, unassigned, archived].map((item) => link(pricing!.id, { routineId: item.id })),
      link(market!.id, { projectId: project.id }),
      link(ops!.id, { routineId: scheduled.id }),
      link(letGo!.id, { issueId: fix.id }),
      link(someoneElse!.id, { issueId: fix.id }),
    ]);
    return {
      company, agent, project,
      responsibilities: { pricing: pricing!, market: market!, ops: ops!, empty: empty!, letGo: letGo!, someoneElse: someoneElse! },
      tasks: { weekly, fix, viaProject },
      routines: { running, paused, unassigned, projectRoutine, scheduled },
    };
  }

  async function read(companyId: string, actor: Actor = boardActor(), query = "") {
    return request(createApp(actor)).get(`/api/companies/${companyId}/responsibilities/automation${query}`);
  }

  function byId(body: ResponsibilityAutomationOverview, id: string): ResponsibilityAutomation {
    const found = body.responsibilities.find((item) => item.responsibilityId === id);
    if (!found) throw new Error(`No automation for ${id}`);
    return found;
  }

  it("is not there while the responsibilities experiment is off", async () => {
    const seeded = await seed();
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
    expect((await read(seeded.company.id)).status).toBe(404);
  });

  it("puts each of the owner's active responsibilities at its level, counting only running automations and manual tasks", async () => {
    const seeded = await seed();
    const res = await read(seeded.company.id);
    expect(res.status).toBe(200);
    const body = res.body as ResponsibilityAutomationOverview;
    const { pricing, market, ops, empty } = seeded.responsibilities;
    // Only the owner's active ones, in their order.
    expect(body.responsibilities.map((item) => item.responsibilityId)).toEqual([pricing.id, market.id, ops.id, empty.id]);

    // Pricing: 1 running automation against 2 manual tasks (the weekly review and the fix).
    const pricingRow = byId(body, pricing.id);
    expect(pricingRow).toMatchObject({
      level: "some_automated",
      automationCount: 1,
      manualTaskCount: 2,
      openManualTaskCount: 1,
      nothingFiled: false,
      candidateTotal: 2,
    });
    expect(pricingRow.share).toBeCloseTo(1 / 3);
    expect(pricingRow.automations.map((routine) => [routine.title, routine.start.kind])).toEqual([["Daily price check", "on_request"]]);
    expect(pricingRow.stalledAutomations.map((routine) => [routine.title, routine.reason])).toEqual([
      ["Monthly discount audit", "paused"],
      ["Quarterly price list", "no_agent"],
    ]);
    expect(pricingRow.candidates.map((candidate) => [candidate.title, candidate.reason, candidate.hint?.trigger ?? null, candidate.cadenceSource])).toEqual([
      ["Weekly pricing review", "hint", "schedule", "title"],
      ["Fix the checkout button", "open", null, "default"],
    ]);
    expect(pricingRow.candidates[0]!.suggestedCadence).toMatchObject({ frequency: "weekly", dayOfWeek: "monday", time: "09:00" });
    // The task's own agent, else an agent already working under the responsibility.
    expect(pricingRow.candidates.map((candidate) => candidate.responsibleAgentId)).toEqual([seeded.agent.id, seeded.agent.id]);
    expect(pricingRow.candidates[0]!.conversation).toBeNull();

    // Market: through its project, 1 routine and 1 task finished by an agent: exactly half.
    expect(byId(body, market.id)).toMatchObject({
      level: "mostly_automated",
      share: 0.5,
      automationCount: 1,
      manualTaskCount: 1,
      automations: [{ id: seeded.routines.projectRoutine.id }],
      candidates: [{ issueId: seeded.tasks.viaProject.id, reason: "done_by_agent", hint: null }],
    });

    // Ops: a scheduled routine and no hand work, with its schedule in words.
    const opsRow = byId(body, ops.id);
    expect(opsRow).toMatchObject({ level: "automated", share: 1, manualTaskCount: 0, candidates: [] });
    expect(opsRow.automations[0]).toMatchObject({
      title: "Ops digest",
      assigneeAgentId: seeded.agent.id,
      start: { kind: "schedule", cadenceLabel: "Every Monday at 9 AM", timezone: "UTC" },
    });
    expect((opsRow.automations[0]!.start as { nextRunAt: string | null }).nextRunAt).toBeTruthy();
    expect(opsRow.automations[0]!.lastRunAt).toBeTruthy();

    // Nothing filed: manual, no share.
    expect(byId(body, empty.id)).toMatchObject({ level: "manual", share: null, nothingFiled: true, automationCount: 0, manualTaskCount: 0 });

    expect(body.totals).toMatchObject({
      responsibilities: 4,
      byLevel: { manual: 1, some_automated: 1, mostly_automated: 1, automated: 1 },
      automations: 3,
      manualTasks: 3,
      share: 0.5,
    });
    expect(body.recentDays).toBe(30);
    expect(body.areas).toEqual([{ areaId: null, automations: 3, manualTasks: 3, share: 0.5 }]);
  });

  it("shows an agent's pending offer on a finished task and suggests its cadence", async () => {
    const seeded = await seed();
    await issueThreadInteractionService(db).createRoutineSuggestion(
      { id: seeded.tasks.weekly.id, companyId: seeded.company.id },
      {
        payload: {
          version: 1,
          title: "Weekly pricing review",
          instructions: "Review the price list.",
          message: null,
          cadence: { frequency: "weekly", dayOfWeek: "friday", dayOfMonth: null, time: "08:00" },
          cadenceLabel: "Every Friday at 8 AM",
          cronExpression: "0 8 * * 5",
          assigneeAgentId: seeded.agent.id,
          projectId: null,
        },
        title: 'Repeat "Weekly pricing review"?',
        summary: "Every Friday at 8 AM",
        createdByAgentId: seeded.agent.id,
        sourceRunId: null,
      },
    );
    const body = (await read(seeded.company.id)).body as ResponsibilityAutomationOverview;
    const [first] = byId(body, seeded.responsibilities.pricing.id).candidates;
    expect(first).toMatchObject({
      issueId: seeded.tasks.weekly.id,
      reason: "pending_offer",
      cadenceSource: "offer",
      suggestedCadence: { frequency: "weekly", dayOfWeek: "friday", time: "08:00" },
      pendingOffer: { agentId: seeded.agent.id, cadenceLabel: "Every Friday at 8 AM", title: "Weekly pricing review" },
    });
  });

  it("drops a task once a person sets it up by hand as a routine, and the responsibility's share rises", async () => {
    const seeded = await seed();
    const made = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.tasks.weekly.id}/repeat-as-routine`)
      .send({ title: "Weekly pricing review", cadence: { frequency: "weekly", dayOfWeek: "monday", time: "09:00" }, assigneeAgentId: seeded.agent.id, timezone: "UTC" });
    expect(made.status).toBe(201);
    expect(made.body.responsibilityIds).toEqual([seeded.responsibilities.pricing.id]);

    const body = (await read(seeded.company.id)).body as ResponsibilityAutomationOverview;
    const pricingRow = byId(body, seeded.responsibilities.pricing.id);
    expect(pricingRow).toMatchObject({ level: "mostly_automated", automationCount: 2, manualTaskCount: 1 });
    expect(pricingRow.candidates.map((candidate) => candidate.issueId)).toEqual([seeded.tasks.fix.id]);
    expect(pricingRow.manualTaskIds).toEqual([seeded.tasks.fix.id]);
    expect(pricingRow.automations.find((routine) => routine.id === made.body.routine.id)?.start).toMatchObject({ kind: "schedule", cadenceLabel: "Every Monday at 9 AM" });
  });

  it("follows the overview's access and owner rules", async () => {
    const seeded = await seed();
    // Agents name the person.
    const agent: Actor = { type: "agent", companyId: seeded.company.id, agentId: seeded.agent.id, source: "agent_jwt" };
    expect((await read(seeded.company.id, agent)).status).toBe(422);
    const asAgent = await read(seeded.company.id, agent, `?ownerUserId=${OWNER}`);
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.responsibilities).toHaveLength(4);

    // Another person's dashboard by ownerUserId.
    const theirs = await read(seeded.company.id, boardActor(), "?ownerUserId=someone-else");
    expect(theirs.body.responsibilities.map((item: ResponsibilityAutomation) => item.responsibilityId)).toEqual([seeded.responsibilities.someoneElse.id]);

    // A board user from outside the company cannot read it.
    const outsider: Actor = {
      type: "board", userId: "outsider", source: "session", sessionId: "s-outsider",
      companyIds: [], memberships: [], isInstanceAdmin: false,
    };
    expect((await read(seeded.company.id, outsider)).status).toBe(403);
  });
});
