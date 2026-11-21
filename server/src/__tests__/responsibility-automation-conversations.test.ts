import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
  responsibilities,
  responsibilityLinks,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { ResponsibilityAutomation, ResponsibilityAutomationOverview } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { responsibilityAutomationRoutes } from "../routes/responsibility-automation.js";
import { routineSuggestionRoutes } from "../routes/routine-suggestions.js";
import { buildAutomationConversationGuidance, loadAutomationConversationGuidance } from "../services/automation-conversation-guidance.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { buildStandingCheckGuidance, loadStandingCheckGuidance, standingCheckService } from "../services/routine-standing-checks.js";
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
const OTHER = "automation-other";
const HEARTBEAT_ON = { heartbeat: { enabled: true, intervalSec: 1800 } };

function localBoardActor(): Actor {
  return { type: "board", userId: OWNER, source: "local_implicit", isInstanceAdmin: true };
}

function sessionBoardActor(companyId: string, userId: string, role = "viewer"): Actor {
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

const SCHEDULE = {
  title: "Send the weekly investor update",
  instructions: "Collect this week's pipeline changes and send the update to the investor list.",
  trigger: { kind: "schedule", cadence: { frequency: "weekly", dayOfWeek: "friday", time: "16:00" } },
  message: "This can go out every Friday afternoon.",
};
const WEBHOOK = {
  title: "Triage new support tickets",
  instructions: "Read the new ticket, label it and assign it.",
  trigger: { kind: "webhook", caller: "The help desk, each time a ticket is opened" },
};
const STANDING = {
  title: "Chase overdue invoices",
  instructions: "Look through open invoices.",
  trigger: { kind: "standing_check", lookFor: "Invoices more than a week overdue", whenFound: "Send the customer a reminder and create a task if it is a month late" },
};

describeEmbeddedPostgres("automation conversations and standing checks", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wakeup: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-automation-conversations-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 8 });
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
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
    app.use("/api", responsibilityAutomationRoutes(db, { heartbeat }));
    app.use("/api", routineSuggestionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Automate Co", issuePrefix: `C${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: OTHER, status: "active", membershipRole: "viewer" },
    ]);
    const [analyst, watcher, runner] = await db.insert(agents).values([
      { companyId: company.id, name: "Analyst", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {} },
      { companyId: company.id, name: "Watcher", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: HEARTBEAT_ON },
      { companyId: company.id, name: "Native", role: "general", status: "idle", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: HEARTBEAT_ON },
    ]).returning();
    const [finance, other] = await db.insert(responsibilities).values([
      { companyId: company.id, ownerUserId: OWNER, title: "Finance", status: "active", sortOrder: 0 },
      { companyId: company.id, ownerUserId: OWNER, title: "Investors", status: "active", sortOrder: 1 },
    ]).returning();
    const task = (values: Partial<typeof issues.$inferInsert> & { title: string }) =>
      db.insert(issues).values({ companyId: company.id, status: "todo", priority: "medium", ...values }).returning().then((rows) => rows[0]!);
    const weekly = await task({ title: "Send the weekly investor update", status: "done", assigneeAgentId: analyst!.id, completedAt: new Date() });
    const tickets = await task({ title: "Triage new support tickets" });
    const invoices = await task({ title: "Follow up on overdue invoices", assigneeAgentId: watcher!.id });
    const onboarding = await task({ title: "Getting to know you", originKind: "onboarding_first_task" });
    const routineMade = await task({ title: "Digest run", originKind: "routine_execution", originId: randomUUID() });
    const cancelled = await task({ title: "Dropped idea", status: "cancelled" });
    await db.insert(responsibilityLinks).values([
      ...[weekly, tickets, invoices].map((item) => ({ companyId: company.id, responsibilityId: finance!.id, issueId: item.id })),
      { companyId: company.id, responsibilityId: other!.id, issueId: weekly.id },
    ]);
    return {
      company,
      agents: { analyst: analyst!, watcher: watcher!, native: runner! },
      responsibilities: { finance: finance!, other: other! },
      tasks: { weekly, tickets, invoices, onboarding, routineMade, cancelled },
      app: createApp(localBoardActor()),
    };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function start(seeded: Seeded, issueId: string, body: object = {}) {
    return request(seeded.app).post(`/api/issues/${issueId}/automation-conversation`).send(body);
  }

  async function propose(seeded: Seeded, agentId: string, issueId: string, body: object) {
    return request(createApp(agentActor(seeded.company.id, agentId))).post(`/api/issues/${issueId}/automation-proposals`).send(body);
  }

  async function read(seeded: Seeded) {
    const res = await request(seeded.app).get(`/api/companies/${seeded.company.id}/responsibilities/automation`);
    expect(res.status).toBe(200);
    return res.body as ResponsibilityAutomationOverview;
  }

  function row(body: ResponsibilityAutomationOverview, id: string): ResponsibilityAutomation {
    return body.responsibilities.find((item) => item.responsibilityId === id)!;
  }

  async function actions(companyId: string) {
    return (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, companyId))).map((entry) => entry.action);
  }

  /** Start a conversation with `agentId` and have it propose `body`; returns the conversation and card ids. */
  async function proposed(seeded: Seeded, sourceId: string, agentId: string, body: object) {
    const started = await start(seeded, sourceId, { agentId });
    expect(started.status).toBe(201);
    const issueId = started.body.conversation.issueId as string;
    const card = await propose(seeded, agentId, issueId, body);
    expect(card.status).toBe(201);
    return { issueId, interactionId: card.body.id as string };
  }

  it("is not there while the responsibilities experiment is off", async () => {
    const seeded = await seed();
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
    expect((await start(seeded, seeded.tasks.weekly.id)).status).toBe(404);
    expect((await request(seeded.app).get(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`)).status).toBe(404);
    expect((await propose(seeded, seeded.agents.analyst.id, seeded.tasks.weekly.id, SCHEDULE)).status).toBe(404);
    const [routine] = await db.insert(routines).values({ companyId: seeded.company.id, title: "Check", assigneeAgentId: seeded.agents.watcher.id }).returning();
    const reported = await request(createApp(agentActor(seeded.company.id, seeded.agents.watcher.id)))
      .post(`/api/routines/${routine!.id}/standing-check-results`).send({ outcome: "nothing_needed" });
    expect(reported.status).toBe(404);
  });

  it("opens one conversation with the responsible agent, carrying the person's message and the hint, and reopens it", async () => {
    const seeded = await seed();
    const before = await request(seeded.app).get(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`);
    expect(before.body).toMatchObject({ state: "none", defaultAgentId: seeded.agents.analyst.id, conversation: null, proposal: null });

    const started = await start(seeded, seeded.tasks.weekly.id, { responsibilityId: seeded.responsibilities.finance.id });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ state: "discussing", conversation: { agentId: seeded.agents.analyst.id, title: "Automate “Send the weekly investor update”" } });
    const issueId = started.body.conversation.issueId as string;
    const [conversation] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(conversation).toMatchObject({
      originKind: "automation_conversation", originId: seeded.tasks.weekly.id, assigneeAgentId: seeded.agents.analyst.id, createdByUserId: OWNER, status: "todo", parentId: null,
    });
    expect(conversation!.description).toContain("by hand at the moment");
    expect(conversation!.description).toContain("Quick suggestion from its title (only a guess): The title says “weekly”");
    expect(conversation!.description).toContain(`/${seeded.company.issuePrefix}/issues/${seeded.tasks.weekly.identifier ?? seeded.tasks.weekly.id})`);
    expect(wakeup).toHaveBeenCalledWith(seeded.agents.analyst.id, expect.objectContaining({ payload: expect.objectContaining({ issueId }) }));
    expect(await actions(seeded.company.id)).toEqual(expect.arrayContaining(["issue.created", "issue.automation_conversation_started"]));

    const again = await start(seeded, seeded.tasks.weekly.id, { agentId: seeded.agents.watcher.id });
    expect(again.status).toBe(200);
    expect(again.body.conversation.issueId).toBe(issueId);

    // The read shows the open conversation on the task, with its agent.
    const candidate = row(await read(seeded), seeded.responsibilities.finance.id).candidates.find((item) => item.issueId === seeded.tasks.weekly.id)!;
    expect(candidate.conversation).toMatchObject({ issueId, state: "discussing", agentId: seeded.agents.analyst.id });
    expect(candidate.responsibleAgentId).toBe(seeded.agents.analyst.id);
  });

  it("refuses tasks that cannot be automated, and people without permission", async () => {
    const seeded = await seed();
    expect((await start(seeded, seeded.tasks.onboarding.id)).status).toBe(422);
    expect((await start(seeded, seeded.tasks.routineMade.id)).status).toBe(422);
    expect((await start(seeded, seeded.tasks.cancelled.id)).status).toBe(409);
    const started = await start(seeded, seeded.tasks.tickets.id, { agentId: seeded.agents.analyst.id });
    // A conversation cannot itself be automated.
    expect((await start(seeded, started.body.conversation.issueId)).status).toBe(422);
    // Agents and people without the assignment permission cannot start one.
    expect((await request(createApp(agentActor(seeded.company.id, seeded.agents.analyst.id)))
      .post(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`).send({})).status).toBe(403);
    expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER)))
      .post(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`).send({})).status).toBe(403);
  });

  it("hides a private task's conversation from a member who cannot read the task", async () => {
    const seeded = await seed();
    const privateId = randomUUID();
    await db.insert(issues).values({
      id: privateId, companyId: seeded.company.id, title: "Confidential payroll run", status: "done", priority: "medium",
      visibility: "private", privacyRootIssueId: privateId, responsibleUserId: "private-owner",
    });
    const asOther = createApp(sessionBoardActor(seeded.company.id, OTHER));
    expect((await request(asOther).get(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`)).status).toBe(200);
    const read = await request(asOther).get(`/api/issues/${privateId}/automation-conversation`);
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain("Confidential payroll run");
    const start = await request(asOther).post(`/api/issues/${privateId}/automation-conversation`).send({});
    expect([403, 404]).toContain(start.status);
    expect(JSON.stringify(start.body)).not.toContain("Confidential payroll run");
    expect(await db.select().from(issues).where(eq(issues.originId, privateId))).toHaveLength(0);
  });

  it("refuses to automate a private task, since routines are visible company-wide", async () => {
    const seeded = await seed();
    const privateId = randomUUID();
    await db.insert(issues).values({
      id: privateId, companyId: seeded.company.id, title: "Confidential payroll run", status: "done", priority: "medium",
      visibility: "private", privacyRootIssueId: privateId, responsibleUserId: OWNER, assigneeUserId: OWNER,
    });
    const started = await start(seeded, privateId, { agentId: seeded.agents.analyst.id });
    expect(started.status).toBe(422);
    expect(started.body.details?.code ?? started.body.code).toBe("routine_from_task_private");
    expect(await db.select().from(issues).where(eq(issues.originId, privateId))).toHaveLength(0);
    const [open] = await db.select().from(issues).where(eq(issues.id, (await start(seeded, seeded.tasks.weekly.id, { agentId: seeded.agents.analyst.id })).body.conversation.issueId));
    expect(open).toMatchObject({ visibility: "private", responsibleUserId: OWNER });
  });

  it("lets only the conversation's agent propose, validates, keeps one pending, and creates nothing", async () => {
    const seeded = await seed();
    const started = await start(seeded, seeded.tasks.weekly.id, { agentId: seeded.agents.analyst.id });
    const issueId = started.body.conversation.issueId as string;
    expect((await propose(seeded, seeded.agents.watcher.id, issueId, SCHEDULE)).status).toBe(404);
    expect((await request(seeded.app).post(`/api/issues/${issueId}/automation-proposals`).send(SCHEDULE)).status).toBe(403);
    expect((await propose(seeded, seeded.agents.analyst.id, seeded.tasks.weekly.id, SCHEDULE)).status).toBe(422);
    expect((await propose(seeded, seeded.agents.analyst.id, issueId, { ...SCHEDULE, trigger: { kind: "schedule", cadence: { frequency: "weekly", time: "16:00" } } })).status).toBe(400);
    // The analyst has no heartbeat, so a standing check would never run.
    const noHeartbeat = await propose(seeded, seeded.agents.analyst.id, issueId, STANDING);
    expect(noHeartbeat.status).toBe(422);
    expect(noHeartbeat.body.details?.code ?? noHeartbeat.body.code).toBe("automation_standing_check_no_heartbeat");

    const first = await propose(seeded, seeded.agents.analyst.id, issueId, SCHEDULE);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: "propose_automation",
      status: "pending",
      payload: {
        sourceIssueId: seeded.tasks.weekly.id,
        title: SCHEDULE.title,
        startLabel: "Every Friday at 4 PM",
        agentName: "Analyst",
        trigger: { kind: "schedule", cadenceLabel: "Every Friday at 4 PM", cronExpression: "0 16 * * 5" },
        filedUnder: [{ title: "Finance" }, { title: "Investors" }],
      },
    });
    const second = await propose(seeded, seeded.agents.analyst.id, issueId, WEBHOOK);
    expect(second.status).toBe(201);
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(cards.map((card) => [card.id === first.body.id ? "first" : "second", card.status]).sort()).toEqual([["first", "expired"], ["second", "pending"]]);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
    const state = await request(seeded.app).get(`/api/issues/${seeded.tasks.weekly.id}/automation-conversation`);
    expect(state.body).toMatchObject({ state: "proposal_waiting", proposal: { id: second.body.id } });
  });

  it("accepts a schedule exactly as repeat-as-routine makes it, atomically, and the share rises", async () => {
    const seeded = await seed();
    const before = row(await read(seeded), seeded.responsibilities.finance.id);
    expect(before).toMatchObject({ level: "manual", automationCount: 0, manualTaskCount: 3 });
    const { issueId, interactionId } = await proposed(seeded, seeded.tasks.weekly.id, seeded.agents.analyst.id, SCHEDULE);
    expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER)))
      .post(`/api/issues/${issueId}/automation-proposals/${interactionId}/accept`).send({ timezone: "UTC" })).status).toBe(404);

    const accepts = await Promise.all([1, 2].map(() =>
      request(seeded.app).post(`/api/issues/${issueId}/automation-proposals/${interactionId}/accept`).send({ timezone: "America/New_York" })));
    expect(accepts.map((res) => res.status).sort()).toEqual([200, 409]);
    const accepted = accepts.find((res) => res.status === 200)!.body;
    expect(accepted.webhook).toBeNull();
    const made = await db.select().from(routines).where(eq(routines.companyId, seeded.company.id));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: SCHEDULE.title, assigneeAgentId: seeded.agents.analyst.id, originKind: "repeated_task", originId: seeded.tasks.weekly.id, status: "active" });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, made[0]!.id));
    expect(trigger).toMatchObject({ kind: "schedule", cronExpression: "0 16 * * 5", timezone: "America/New_York", label: "Every Friday at 4 PM" });
    const filed = await db.select().from(responsibilityLinks).where(eq(responsibilityLinks.routineId, made[0]!.id));
    expect(filed.map((link) => link.responsibilityId).sort()).toEqual([seeded.responsibilities.finance.id, seeded.responsibilities.other.id].sort());
    expect(accepted.interaction).toMatchObject({ status: "accepted", result: { outcome: "accepted", routineId: made[0]!.id, cadenceLabel: "Every Friday at 4 PM", timezone: "America/New_York" } });
    expect(await actions(seeded.company.id)).toEqual(expect.arrayContaining(["routine.created", "routine.trigger_created", "responsibility.linked", "issue.thread_interaction_accepted"]));

    const after = row(await read(seeded), seeded.responsibilities.finance.id);
    expect(after).toMatchObject({ level: "some_automated", automationCount: 1, manualTaskCount: 2 });
    expect(after.candidates.map((candidate) => candidate.issueId)).not.toContain(seeded.tasks.weekly.id);
    // And it is not offered again.
    expect((await start(seeded, seeded.tasks.weekly.id)).status).toBe(409);
  });

  it("accepts a webhook through the routines module, showing the address and secret once", async () => {
    const seeded = await seed();
    const { issueId, interactionId } = await proposed(seeded, seeded.tasks.tickets.id, seeded.agents.analyst.id, WEBHOOK);
    const res = await request(seeded.app).post(`/api/issues/${issueId}/automation-proposals/${interactionId}/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.webhook).toMatchObject({ signingMode: "bearer" });
    expect(res.body.webhook.url).toMatch(/^http:\/\/localhost:3100\/api\/routine-triggers\/public\/[0-9a-f]+\/fire$/);
    expect(res.body.webhook.secret).toMatch(/^[0-9a-f]{20,}$/);
    // The card keeps the address and how it is secured, never the secret.
    expect(res.body.interaction.result).toMatchObject({ webhookUrl: res.body.webhook.url, signingMode: "bearer" });
    expect(JSON.stringify(res.body.interaction)).not.toContain(res.body.webhook.secret);
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, res.body.routine.id));
    expect(trigger).toMatchObject({ kind: "webhook", signingMode: "bearer", enabled: true });
    const automation = row(await read(seeded), seeded.responsibilities.finance.id).automations[0]!;
    expect(automation.start).toMatchObject({ kind: "webhook", webhookUrl: res.body.webhook.url, signingMode: "bearer" });
  });

  it("accepts a standing check as a routine that never fires, and stalls it when its agent stops waking", async () => {
    const seeded = await seed();
    const { issueId, interactionId } = await proposed(seeded, seeded.tasks.invoices.id, seeded.agents.watcher.id, STANDING);
    const res = await request(seeded.app).post(`/api/issues/${issueId}/automation-proposals/${interactionId}/accept`).send({});
    expect(res.status).toBe(200);
    const [routine] = await db.select().from(routines).where(eq(routines.id, res.body.routine.id));
    expect(routine!.description).toContain("What to look for: Invoices more than a week overdue");
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({ kind: "heartbeat", nextRunAt: null, cronExpression: null, publicId: null });

    let finance = row(await read(seeded), seeded.responsibilities.finance.id);
    expect(finance.automations[0]).toMatchObject({ id: routine!.id, start: { kind: "standing_check", lastResult: null } });
    expect(finance.automationCount).toBe(1);

    // Its agent stops waking up on its own: the check is called out and no longer counts.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false } } }).where(eq(agents.id, seeded.agents.watcher.id));
    finance = row(await read(seeded), seeded.responsibilities.finance.id);
    expect(finance.automationCount).toBe(0);
    expect(finance.stalledAutomations).toEqual([expect.objectContaining({ id: routine!.id, startKind: "standing_check", reason: "no_wakeups" })]);
  });

  it("declining closes the card and the conversation continues", async () => {
    const seeded = await seed();
    const { issueId, interactionId } = await proposed(seeded, seeded.tasks.weekly.id, seeded.agents.analyst.id, SCHEDULE);
    const declined = await request(seeded.app).post(`/api/issues/${issueId}/automation-proposals/${interactionId}/decline`).send({});
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: "rejected", result: { outcome: "declined" } });
    expect((await request(seeded.app).post(`/api/issues/${issueId}/automation-proposals/${interactionId}/accept`).send({})).status).toBe(409);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
    expect((await propose(seeded, seeded.agents.analyst.id, issueId, WEBHOOK)).status).toBe(201);
  });

  it("keeps a proposal open, out of the inbox, after the agent finishes, and withdraws it when cancelled", async () => {
    const seeded = await seed();
    const { issueId, interactionId } = await proposed(seeded, seeded.tasks.weekly.id, seeded.agents.analyst.id, SCHEDULE);
    const interactions = issueThreadInteractionService(db);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    await interactions.expirePendingInteractionsForTerminalIssue({ id: issueId, companyId: seeded.company.id, status: "done" });
    expect((await interactions.listForIssue(issueId)).map((entry) => entry.status)).toEqual(["pending"]);
    expect((await start(seeded, seeded.tasks.weekly.id)).status).toBe(200);

    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
    await interactions.expirePendingInteractionsForTerminalIssue({ id: issueId, companyId: seeded.company.id, status: "cancelled" });
    const [withdrawn] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(withdrawn!.status).toBe("expired");
    expect((await propose(seeded, seeded.agents.analyst.id, issueId, SCHEDULE)).status).toBe(409);
  });

  it("gives the agent its instructions only in its own automation conversation", async () => {
    const seeded = await seed();
    const started = await start(seeded, seeded.tasks.invoices.id, { agentId: seeded.agents.watcher.id });
    const issueId = started.body.conversation.issueId as string;
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const issue = { id: task!.id, companyId: task!.companyId, originKind: task!.originKind, originId: task!.originId, assigneeAgentId: task!.assigneeAgentId };
    const guidance = (await loadAutomationConversationGuidance(db, { issue, agentId: seeded.agents.watcher.id }))!;
    expect(guidance).toContain("- Title: Follow up on overdue invoices");
    expect(guidance).toContain("- Filed under the responsibilities: Finance");
    expect(guidance).toContain("a standing check on each wake-up could fit");
    expect(guidance).toContain("- standing_check: you carry it out each time your heartbeat wakes you (every 30 minutes)");
    expect(guidance).toContain(`POST /api/issues/${issueId}/automation-proposals`);
    expect(await loadAutomationConversationGuidance(db, { issue, agentId: seeded.agents.analyst.id })).toBeNull();
    expect(await loadAutomationConversationGuidance(db, { issue: { ...issue, originKind: "manual" }, agentId: seeded.agents.watcher.id })).toBeNull();

    // An agent that never wakes on its own is not offered standing checks.
    const pure = buildAutomationConversationGuidance({
      issueId, personName: null, agentName: "Native", standingChecksAvailable: false, heartbeatInterval: "never",
      task: { identifier: null, title: "Chase", description: null, status: "todo", withAgent: false, filedUnder: [], hint: null }, proposals: [],
    });
    expect(pure).toContain("standing_check is not available");
    expect(pure).not.toContain("\"kind\":\"standing_check\"");
  });

  describe("standing checks", () => {
    async function standingCheck(seeded: Seeded, values: Partial<typeof routines.$inferInsert> = {}, trigger: Partial<typeof routineTriggers.$inferInsert> = {}) {
      const [routine] = await db.insert(routines).values({
        companyId: seeded.company.id, title: "Chase overdue invoices", description: "Remind customers.", assigneeAgentId: seeded.agents.watcher.id, status: "active", ...values,
      }).returning();
      await db.insert(routineTriggers).values({ companyId: seeded.company.id, routineId: routine!.id, kind: "heartbeat", label: "Standing check", ...trigger });
      await db.insert(responsibilityLinks).values({ companyId: seeded.company.id, responsibilityId: seeded.responsibilities.finance.id, routineId: routine!.id });
      return routine!;
    }

    it("are listed in the heartbeat prompt only for their agent and only while active", async () => {
      const seeded = await seed();
      const active = await standingCheck(seeded);
      await standingCheck(seeded, { title: "Paused check", status: "paused" });
      await standingCheck(seeded, { title: "Disabled check" }, { enabled: false });
      await standingCheck(seeded, { title: "Someone else's", assigneeAgentId: seeded.agents.analyst.id });
      const guidance = (await loadStandingCheckGuidance(db, { companyId: seeded.company.id, agentId: seeded.agents.watcher.id }))!;
      expect(guidance).toContain(`1. Chase overdue invoices (routine ${active.id})`);
      expect(guidance).toContain("Remind customers.");
      expect(guidance).toContain("POST /api/routines/{routineId}/standing-check-results");
      expect(guidance).not.toContain("Paused check");
      expect(guidance).not.toContain("Disabled check");
      expect(guidance).not.toContain("Someone else's");
      expect(await loadStandingCheckGuidance(db, { companyId: seeded.company.id, agentId: seeded.agents.native.id })).toBeNull();
      expect(buildStandingCheckGuidance({ checks: [] })).toContain("these 0 standing checks");
    });

    it("record each outcome for the routine's agent only, and show the last one", async () => {
      const seeded = await seed();
      const routine = await standingCheck(seeded);
      const asWatcher = createApp(agentActor(seeded.company.id, seeded.agents.watcher.id));
      const asAnalyst = createApp(agentActor(seeded.company.id, seeded.agents.analyst.id));
      const url = `/api/routines/${routine.id}/standing-check-results`;
      expect((await request(asAnalyst).post(url).send({ outcome: "nothing_needed" })).status).toBe(403);
      expect((await request(seeded.app).post(url).send({ outcome: "nothing_needed" })).status).toBe(403);
      expect((await request(asWatcher).post(url).send({ outcome: "acted" })).status).toBe(400);
      expect((await request(asWatcher).post(url).send({ outcome: "nothing_needed" })).status).toBe(201);
      const acted = await request(asWatcher).post(url).send({ outcome: "acted", note: "Reminded two customers", issueId: seeded.tasks.invoices.id });
      expect(acted.status).toBe(201);
      const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
      expect(runs.map((run) => [run.source, run.status])).toEqual([["heartbeat", "completed"], ["heartbeat", "completed"]]);
      const [trigger] = await db.select().from(routineTriggers).where(and(eq(routineTriggers.routineId, routine.id), eq(routineTriggers.kind, "heartbeat")));
      expect(trigger!.lastResult).toBe("Acted: Reminded two customers");
      expect(await actions(seeded.company.id)).toContain("routine.standing_check_reported");

      const automation = row(await read(seeded), seeded.responsibilities.finance.id).automations.find((item) => item.id === routine.id)!;
      expect(automation.start).toMatchObject({
        kind: "standing_check",
        lastResult: { outcome: "acted", note: "Reminded two customers", issue: { id: seeded.tasks.invoices.id, title: "Follow up on overdue invoices" } },
      });
      const guidance = (await loadStandingCheckGuidance(db, { companyId: seeded.company.id, agentId: seeded.agents.watcher.id }))!;
      expect(guidance).toContain("acted (Reminded two customers)");
    });

    it("leave out a linked task the reader cannot see", async () => {
      const seeded = await seed();
      const routine = await standingCheck(seeded);
      const reported = await request(createApp(agentActor(seeded.company.id, seeded.agents.watcher.id)))
        .post(`/api/routines/${routine.id}/standing-check-results`)
        .send({ outcome: "acted", note: "Reminded two customers", issueId: seeded.tasks.invoices.id });
      expect(reported.status).toBe(201);
      const checks = standingCheckService(db);
      const visible = await checks.lastResults(seeded.company.id, [routine.id], sql<boolean>`true`);
      expect(visible.get(routine.id)?.issue).toMatchObject({ id: seeded.tasks.invoices.id, title: "Follow up on overdue invoices" });
      const hidden = await checks.lastResults(seeded.company.id, [routine.id], sql<boolean>`false`);
      expect(hidden.get(routine.id)).toMatchObject({ outcome: "acted", note: "Reminded two customers", issue: null });
    });

    it("refuse reports while paused, and a person can pause one", async () => {
      const seeded = await seed();
      const routine = await standingCheck(seeded, { status: "paused" });
      const res = await request(createApp(agentActor(seeded.company.id, seeded.agents.watcher.id)))
        .post(`/api/routines/${routine.id}/standing-check-results`).send({ outcome: "nothing_needed" });
      expect(res.status).toBe(409);
      const stalled = row(await read(seeded), seeded.responsibilities.finance.id).stalledAutomations;
      expect(stalled).toEqual([expect.objectContaining({ id: routine.id, reason: "paused", startKind: "standing_check" })]);
    });
  });
});
