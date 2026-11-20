import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
  projects,
  responsibilities,
  responsibilityLinks,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { ROUTINE_FROM_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { routineSuggestionRoutes } from "../routes/routine-suggestions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { routineSuggestionService, type RoutineSuggestionResponsibilityFiling } from "../services/routine-suggestions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINE_SUGGESTIONS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const OWNER = "board-user";

function boardActor(): Actor {
  return { type: "board", userId: OWNER, source: "local_implicit", isInstanceAdmin: true };
}

function agentActor(companyId: string, agentId: string): Actor {
  return { type: "agent", companyId, agentId, source: "agent_jwt" };
}

const WEEKLY_OFFER = {
  title: "Weekly competitor pricing summary",
  instructions: "Check the three competitors' pricing pages and summarize what changed since last week.",
  message: "This looks like something you will want every week.",
  cadence: { frequency: "weekly", dayOfWeek: "monday", time: "09:00" },
};

describeEmbeddedPostgres("routine suggestions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let filedUnder: string[] = [];
  let fakeFiling: RoutineSuggestionResponsibilityFiling;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-suggestions-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    filedUnder = [];
    fakeFiling = {
      responsibilitiesForIssue: async () => [],
      fileRoutine: async () => null,
    };
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: true });
  });

  /** `filing: "module"` uses the real responsibilities module instead of the fake. */
  function createApp(actor: Actor, filing: RoutineSuggestionResponsibilityFiling | "module" = fakeFiling) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", routineSuggestionRoutes(db, { filing: filing === "module" ? undefined : filing }));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: {
    status?: string;
    originKind?: string;
    parentId?: string | null;
    withProject?: boolean;
  } = {}) {
    const company = await db.insert(companies)
      .values({ name: "Routine Co", issuePrefix: `S${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner",
    });
    const agent = await db.insert(agents).values({
      companyId: company.id, name: "Analyst", role: "general", status: "idle",
      adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" },
    }).returning().then((rows) => rows[0]!);
    const project = input.withProject === false ? null
      : await db.insert(projects).values({ companyId: company.id, name: "Market watch" }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      projectId: project?.id ?? null,
      title: "Summarize competitor pricing",
      status: input.status ?? "done",
      priority: "medium",
      assigneeAgentId: agent.id,
      originKind: input.originKind ?? "manual",
      parentId: input.parentId ?? null,
      createdByUserId: OWNER,
    }).returning().then((rows) => rows[0]!);
    return { company, agent, project, issue };
  }

  async function addTask(companyId: string, agentId: string, values: { originKind?: string; parentId?: string | null; status?: string }) {
    return db.insert(issues).values({
      companyId,
      title: "Related task",
      status: values.status ?? "done",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: values.originKind ?? "manual",
      parentId: values.parentId ?? null,
    }).returning().then((rows) => rows[0]!);
  }

  async function offer(seeded: { company: { id: string }; agent: { id: string }; issue: { id: string } }, body: object = WEEKLY_OFFER) {
    return request(createApp(agentActor(seeded.company.id, seeded.agent.id)))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions`).send(body);
  }

  it("is not available while the responsibilities experiment is off", async () => {
    await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
    const seeded = await seed();
    const res = await offer(seeded);
    expect(res.status).toBe(404);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, seeded.issue.id))).toEqual([]);
  });

  it("lets the assigned agent offer once on a finished task, with a server-derived cadence", async () => {
    const seeded = await seed();
    const res = await offer(seeded);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "suggest_routine",
      status: "pending",
      continuationPolicy: "none",
      effectiveResolverPolicy: "human_only",
      createdByAgentId: seeded.agent.id,
      title: 'Repeat "Weekly competitor pricing summary"?',
      summary: "Every Monday at 9 AM",
      payload: {
        cadenceLabel: "Every Monday at 9 AM",
        cronExpression: "0 9 * * 1",
        assigneeAgentId: seeded.agent.id,
        projectId: seeded.project!.id,
        message: "This looks like something you will want every week.",
      },
    });

    // The offer stays open on the done task instead of reading as expired.
    const listed = await issueThreadInteractionService(db).listForIssue(seeded.issue.id);
    expect(listed.map((item) => [item.kind, item.status])).toEqual([["suggest_routine", "pending"]]);

    // Closing paths that expire a done task's cards leave the offer alone.
    await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(
      { id: seeded.issue.id, companyId: seeded.company.id, status: "done" },
    );
    expect((await issueThreadInteractionService(db).listForIssue(seeded.issue.id))[0]!.status).toBe("pending");

    const again = await offer(seeded, { ...WEEKLY_OFFER, title: "Something else" });
    expect(again.status).toBe(409);
    expect(again.body.details?.code ?? again.body.code).toBe("routine_suggestion_exists");

    const [activity] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seeded.company.id),
      eq(activityLog.action, "issue.thread_interaction_created"),
    ));
    expect(activity?.details).toMatchObject({ interactionKind: "suggest_routine" });
  });

  it("never offers for a cancelled task", async () => {
    const seeded = await seed({ status: "cancelled" });
    const res = await offer(seeded);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("routine_suggestion_task_not_done");
  });

  it("holds an offer made before the task is done until it finishes successfully", async () => {
    // A native agent's completion settles after its turn, so its offer can
    // arrive while the task is still open.
    const seeded = await seed({ status: "in_progress" });
    const offered = await offer(seeded);
    expect(offered.status).toBe(201);
    const interactions = issueThreadInteractionService(db);
    expect(await interactions.listForIssue(seeded.issue.id)).toEqual([]);
    const early = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(early.status).toBe(409);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);

    for (const status of ["in_review", "blocked"]) {
      await db.update(issues).set({ status }).where(eq(issues.id, seeded.issue.id));
      expect(await interactions.listForIssue(seeded.issue.id), status).toEqual([]);
    }

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issue.id));
    expect((await interactions.listForIssue(seeded.issue.id)).map((item) => item.status)).toEqual(["pending"]);
    const accepted = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(accepted.status).toBe(200);
  });

  it("refuses work a routine created, including its subtasks", async () => {
    const seeded = await seed({ originKind: "routine_execution" });
    expect((await offer(seeded)).status).toBe(422);

    const child = await addTask(seeded.company.id, seeded.agent.id, { parentId: seeded.issue.id });
    const res = await offer({ ...seeded, issue: child });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("routine");
  });

  it("refuses the onboarding first task and its subtasks", async () => {
    const seeded = await seed({ originKind: "onboarding_first_task" });
    expect((await offer(seeded)).status).toBe(422);
    const child = await addTask(seeded.company.id, seeded.agent.id, { parentId: seeded.issue.id });
    const grandchild = await addTask(seeded.company.id, seeded.agent.id, { parentId: child.id });
    expect((await offer({ ...seeded, issue: grandchild })).status).toBe(422);
  });

  it("only lets the task's own agent make the offer", async () => {
    const seeded = await seed();
    const other = await db.insert(agents).values({
      companyId: seeded.company.id, name: "Other", role: "general", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    expect((await offer({ ...seeded, agent: other })).status).toBe(403);
    const asBoard = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions`).send(WEEKLY_OFFER);
    expect(asBoard.status).toBe(403);
  });

  it("rejects incomplete cadences and template placeholders", async () => {
    const seeded = await seed();
    expect((await offer(seeded, { ...WEEKLY_OFFER, cadence: { frequency: "weekly", time: "09:00" } })).status).toBe(400);
    expect((await offer(seeded, { ...WEEKLY_OFFER, cadence: { frequency: "monthly", dayOfMonth: 31, time: "09:00" } })).status).toBe(400);
    expect((await offer(seeded, { ...WEEKLY_OFFER, instructions: "Summarize {{topic}}" })).status).toBe(400);
    expect((await offer(seeded)).status).toBe(201);
  });

  it("accepting creates a scheduled routine with the task's agent and project, filed under the task's responsibilities", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    fakeFiling = {
      responsibilitiesForIssue: async (companyId, issueId) => {
        expect([companyId, issueId]).toEqual([seeded.company.id, seeded.issue.id]);
        return [{ id: "resp-a" }, { id: "resp-b" }];
      },
      fileRoutine: async (responsibilityId) => {
        filedUnder.push(responsibilityId);
        return { linkId: `link-${responsibilityId}`, created: true };
      },
    };

    // Agents cannot accept their own offer.
    const asAgent = await request(createApp(agentActor(seeded.company.id, seeded.agent.id)))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(asAgent.status).toBe(403);

    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`)
      .send({ timezone: "America/Chicago" });
    expect(res.status).toBe(200);
    const routineId = res.body.routine.id as string;
    expect(res.body.interaction).toMatchObject({
      status: "accepted",
      resolvedByUserId: OWNER,
      result: {
        outcome: "accepted",
        routineId,
        routineTitle: "Weekly competitor pricing summary",
        cadenceLabel: "Every Monday at 9 AM",
        timezone: "America/Chicago",
        responsibilityIds: ["resp-a", "resp-b"],
      },
    });
    expect(filedUnder).toEqual(["resp-a", "resp-b"]);

    const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine).toMatchObject({
      companyId: seeded.company.id,
      assigneeAgentId: seeded.agent.id,
      projectId: seeded.project!.id,
      title: "Weekly competitor pricing summary",
      status: "active",
      responsibleUserId: OWNER,
    });
    const triggers = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      kind: "schedule", cronExpression: "0 9 * * 1", timezone: "America/Chicago", enabled: true, label: "Every Monday at 9 AM",
    });

    const actions = (await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.companyId, seeded.company.id))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      "routine.created", "routine.trigger_created", "responsibility.linked", "issue.thread_interaction_accepted",
    ]));

    // The offer is settled: a second accept makes nothing new.
    const again = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(again.status).toBe(409);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(1);
  });

  it("files the routine under every responsibility the task is under, directly or through its project", async () => {
    const seeded = await seed();
    const [direct, viaProject, letGo] = await db.insert(responsibilities).values([
      { companyId: seeded.company.id, ownerUserId: OWNER, title: "Pricing", status: "active" },
      { companyId: seeded.company.id, ownerUserId: OWNER, title: "Market", status: "active" },
      { companyId: seeded.company.id, ownerUserId: OWNER, title: "Old", status: "let_go" },
    ]).returning();
    await db.insert(responsibilityLinks).values([
      { companyId: seeded.company.id, responsibilityId: direct!.id, issueId: seeded.issue.id },
      { companyId: seeded.company.id, responsibilityId: viaProject!.id, projectId: seeded.project!.id },
      { companyId: seeded.company.id, responsibilityId: letGo!.id, issueId: seeded.issue.id },
    ]);
    const offered = await offer(seeded);
    // No injected filing: use the responsibilities module.
    const res = await request(createApp(boardActor(), "module"))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(res.status).toBe(200);
    const routineId = res.body.routine.id as string;
    const links = await db.select({ responsibilityId: responsibilityLinks.responsibilityId })
      .from(responsibilityLinks).where(eq(responsibilityLinks.routineId, routineId));
    expect(links.map((link) => link.responsibilityId).sort()).toEqual([direct!.id, viaProject!.id].sort());
    expect([...res.body.interaction.result.responsibilityIds].sort()).toEqual([direct!.id, viaProject!.id].sort());
  });

  it("leaves a loose task's routine loose", async () => {
    const seeded = await seed({ withProject: false });
    const offered = await offer(seeded);
    const res = await request(createApp(boardActor(), "module"))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.body.routine.projectId).toBeNull();
    expect(res.body.interaction.result).toMatchObject({ timezone: "UTC", responsibilityIds: [] });
  });

  it("reopens the offer when the routine cannot be created", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.agent.id));
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id));
    expect(row).toMatchObject({ status: "pending", result: null });
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
  });

  async function strandAccept(offerId: string, extra: Record<string, unknown> = {}) {
    const claimedAt = new Date(Date.now() - 5 * 60_000);
    await db.update(issueThreadInteractions).set({
      status: "accepted", result: { version: 1, outcome: "accepted", claimId: "interrupted-claim", ...extra } as never,
      resolvedByUserId: OWNER, resolvedAt: claimedAt, updatedAt: claimedAt,
    }).where(eq(issueThreadInteractions.id, offerId));
  }

  it("finishes an accept that a restart interrupted, archiving only the routine it had made", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    const [stray] = await db.insert(routines).values({
      companyId: seeded.company.id, title: "Weekly competitor pricing summary", assigneeAgentId: seeded.agent.id,
      originKind: ROUTINE_FROM_TASK_ORIGIN_KIND, originId: seeded.issue.id,
    }).returning();
    await strandAccept(offered.body.id, { pendingRoutineId: stray!.id });
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(res.body.interaction.result.routineId).toBe(res.body.routine.id);
    const live = (await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).filter((row) => row.status !== "archived");
    expect(live.map((row) => row.id)).toEqual([res.body.routine.id]);
    expect((await db.select().from(routines).where(eq(routines.id, stray!.id)))[0]).toMatchObject({ status: "archived" });
  });

  it("leaves a routine the person made meanwhile alone, and closes the interrupted offer", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    await strandAccept(offered.body.id);
    const [theirs] = await db.insert(routines).values({
      companyId: seeded.company.id, title: "Their own schedule", assigneeAgentId: seeded.agent.id,
      originKind: ROUTINE_FROM_TASK_ORIGIN_KIND, originId: seeded.issue.id,
    }).returning();
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(res.status).toBe(409);
    const all = await db.select().from(routines).where(eq(routines.companyId, seeded.company.id));
    expect(all.map((row) => [row.id, row.status])).toEqual([[theirs!.id, "active"]]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id)))[0])
      .toMatchObject({ status: "expired" });
  });

  it("stops a slow accept from changing a card another accept took over", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    await strandAccept(offered.body.id);
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(res.status).toBe(200);
    const interactions = issueThreadInteractionService(db);
    const issueRef = { id: seeded.issue.id, companyId: seeded.company.id };
    expect(await interactions.noteAcceptClaimRoutine(issueRef, offered.body.id, "interrupted-claim", randomUUID())).toBe(false);
    await expect(interactions.recordAcceptedRoutineSuggestion(issueRef, offered.body.id, "interrupted-claim", {
      routineId: randomUUID(), routineTitle: "Old", cadenceLabel: "Every Monday at 9 AM", timezone: "UTC", responsibilityIds: [],
    })).rejects.toThrow();
    await interactions.releaseRoutineSuggestionClaim(issueRef, offered.body.id, "interrupted-claim");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id)))[0])
      .toMatchObject({ status: "accepted", result: expect.objectContaining({ routineId: res.body.routine.id }) });
  });

  it("keeps a saved acceptance and its routine when later work fails", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    const real = issueThreadInteractionService(db);
    const failing = {
      ...real,
      recordAcceptedRoutineSuggestion: async (...args: Parameters<typeof real.recordAcceptedRoutineSuggestion>) => {
        await real.recordAcceptedRoutineSuggestion(...args);
        throw new Error("Could not refresh the task");
      },
    };
    const svc = routineSuggestionService(db, { filing: fakeFiling, interactions: failing });
    await expect(svc.accept({ id: seeded.issue.id, companyId: seeded.company.id }, offered.body.id, { timezone: "UTC" }, { userId: OWNER }))
      .rejects.toThrow("Could not refresh the task");
    const all = await db.select().from(routines).where(eq(routines.companyId, seeded.company.id));
    expect(all.map((row) => row.status)).toEqual(["active"]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id)))[0])
      .toMatchObject({ status: "accepted", result: expect.objectContaining({ routineId: all[0]!.id }) });
  });

  it("does not take over an accept that may still be running", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    const claimedAt = new Date(Date.now() - 10_000);
    await db.update(issueThreadInteractions).set({
      status: "accepted", result: { version: 1, outcome: "accepted", claimId: "running-claim" } as never, resolvedByUserId: OWNER, resolvedAt: claimedAt, updatedAt: claimedAt,
    }).where(eq(issueThreadInteractions.id, offered.body.id));
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(res.status).toBe(409);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
  });

  it("never turns a private task into a routine", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: seeded.issue.id, responsibleUserId: OWNER })
      .where(eq(issues.id, seeded.issue.id));
    const accepted = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({ timezone: "UTC" });
    expect(accepted.status).toBe(422);
    const repeated = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/repeat-as-routine`)
      .send({ title: "Weekly", cadence: { frequency: "weekly", dayOfWeek: "monday", time: "09:00" }, assigneeAgentId: seeded.agent.id, timezone: "UTC" });
    expect(repeated.status).toBe(422);
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id)))[0])
      .toMatchObject({ status: "pending" });
  });

  it("declining is quiet and final", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/decline`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "rejected", result: { outcome: "declined" } });
    expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(0);
    const accept = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(accept.status).toBe(409);
    expect((await offer(seeded)).status).toBe(409);
  });

  describe("a person turns a task into a routine", () => {
    const BODY = { title: "Weekly competitor pricing summary", cadence: { frequency: "monthly", dayOfMonth: 3, time: "08:30" }, timezone: "Europe/Berlin" };

    function repeat(seeded: { issue: { id: string } }, body: object, actor: Actor = boardActor(), filing: RoutineSuggestionResponsibilityFiling | "module" = "module") {
      return request(createApp(actor, filing)).post(`/api/issues/${seeded.issue.id}/repeat-as-routine`).send(body);
    }

    it("creates an active scheduled routine with the chosen agent, records the task, and files it under each responsibility", async () => {
      const seeded = await seed({ status: "in_progress" });
      const [direct, viaProject] = await db.insert(responsibilities).values([
        { companyId: seeded.company.id, ownerUserId: OWNER, title: "Pricing", status: "active" },
        { companyId: seeded.company.id, ownerUserId: OWNER, title: "Market", status: "active" },
      ]).returning();
      await db.insert(responsibilityLinks).values([
        { companyId: seeded.company.id, responsibilityId: direct!.id, issueId: seeded.issue.id },
        { companyId: seeded.company.id, responsibilityId: viaProject!.id, projectId: seeded.project!.id },
      ]);
      const res = await repeat(seeded, { ...BODY, assigneeAgentId: seeded.agent.id });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        cadenceLabel: "On the 3rd of every month at 8:30 AM",
        timezone: "Europe/Berlin",
        acceptedOfferId: null,
        routine: { title: "Weekly competitor pricing summary", assigneeAgentId: seeded.agent.id, projectId: seeded.project!.id, status: "active" },
      });
      expect([...res.body.responsibilityIds].sort()).toEqual([direct!.id, viaProject!.id].sort());

      const [routine] = await db.select().from(routines).where(eq(routines.id, res.body.routine.id));
      expect(routine).toMatchObject({ originKind: "repeated_task", originId: seeded.issue.id, responsibleUserId: OWNER });
      expect(routine!.description).toContain("Repeats");
      const triggers = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
      expect(triggers).toHaveLength(1);
      expect(triggers[0]).toMatchObject({ kind: "schedule", cronExpression: "30 8 3 * *", timezone: "Europe/Berlin", label: "On the 3rd of every month at 8:30 AM", enabled: true });
      const links = await db.select({ responsibilityId: responsibilityLinks.responsibilityId })
        .from(responsibilityLinks).where(eq(responsibilityLinks.routineId, routine!.id));
      expect(links.map((link) => link.responsibilityId).sort()).toEqual([direct!.id, viaProject!.id].sort());

      // The task itself is left as it is.
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issue.id));
      expect(task).toMatchObject({ status: "in_progress", title: "Summarize competitor pricing" });

      const actions = (await db.select({ action: activityLog.action }).from(activityLog)
        .where(eq(activityLog.companyId, seeded.company.id))).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(["routine.created", "routine.trigger_created", "responsibility.linked"]));
    });

    it("makes one routine from a double submit", async () => {
      const seeded = await seed();
      const body = { ...BODY, assigneeAgentId: seeded.agent.id };
      const [first, second] = await Promise.all([repeat(seeded, body, boardActor(), fakeFiling), repeat(seeded, body, boardActor(), fakeFiling)]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const refused = first.status === 409 ? first : second;
      expect(JSON.stringify(refused.body)).toContain("routine_origin_exists");
      expect(await db.select().from(routines).where(eq(routines.companyId, seeded.company.id))).toHaveLength(1);
      // Once that routine is archived, the task can be repeated again.
      await db.update(routines).set({ status: "archived" }).where(eq(routines.companyId, seeded.company.id));
      expect((await repeat(seeded, body, boardActor(), fakeFiling)).status).toBe(201);
    });

    it("settles the agent's pending offer on the task with the person's routine", async () => {
      const seeded = await seed();
      const offered = await offer(seeded);
      const res = await repeat(seeded, { ...BODY, assigneeAgentId: seeded.agent.id }, boardActor(), fakeFiling);
      expect(res.status).toBe(201);
      expect(res.body.acceptedOfferId).toBe(offered.body.id);
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id));
      expect(row).toMatchObject({ status: "accepted", result: { outcome: "accepted", routineId: res.body.routine.id, cadenceLabel: "On the 3rd of every month at 8:30 AM" } });
      // The offer's instructions become what each run does.
      const [routine] = await db.select().from(routines).where(eq(routines.id, res.body.routine.id));
      expect(routine!.description).toBe(WEEKLY_OFFER.instructions);
    });

    it("refuses work a routine created, the onboarding task, bar conversations, cancelled tasks, agents and the flag being off", async () => {
      const ok = (seeded: { agent: { id: string } }) => ({ ...BODY, assigneeAgentId: seeded.agent.id });
      const routineMade = await seed({ originKind: "routine_execution" });
      expect((await repeat(routineMade, ok(routineMade))).status).toBe(422);
      const child = await addTask(routineMade.company.id, routineMade.agent.id, { parentId: routineMade.issue.id });
      expect((await repeat({ issue: child }, ok(routineMade))).status).toBe(422);

      const onboarding = await seed({ originKind: "onboarding_first_task" });
      expect((await repeat(onboarding, ok(onboarding))).status).toBe(422);

      const bar = await seed({ originKind: "responsibility_bar" });
      const barRes = await repeat(bar, ok(bar));
      expect(barRes.status).toBe(422);
      expect(JSON.stringify(barRes.body)).toContain("routine_from_task_bar_conversation");

      const cancelled = await seed({ status: "cancelled" });
      expect((await repeat(cancelled, ok(cancelled))).status).toBe(409);

      const plain = await seed();
      expect((await repeat(plain, ok(plain), agentActor(plain.company.id, plain.agent.id))).status).toBe(403);
      expect((await repeat(plain, { ...ok(plain), cadence: { frequency: "weekly", time: "09:00" } })).status).toBe(400);
      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      expect((await repeat(plain, ok(plain))).status).toBe(404);
      expect(await db.select().from(routines).where(eq(routines.companyId, plain.company.id))).toHaveLength(0);
    });
  });

  it("withdraws the offer when the task is cancelled", async () => {
    const seeded = await seed();
    const offered = await offer(seeded);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, seeded.issue.id));
    await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(
      { id: seeded.issue.id, companyId: seeded.company.id, status: "cancelled" },
    );
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id));
    expect(row!.status).toBe("expired");
    const accept = await request(createApp(boardActor()))
      .post(`/api/issues/${seeded.issue.id}/routine-suggestions/${offered.body.id}/accept`).send({});
    expect(accept.status).toBe(409);
  });
});
