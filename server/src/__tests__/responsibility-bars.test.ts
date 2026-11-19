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
  issueThreadInteractions,
  issues,
  responsibilities,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { responsibilityBarRoutes } from "../routes/responsibility-bars.js";
import { responsibilityRoutes } from "../routes/responsibilities.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { loadResponsibilityBarGuidance } from "../services/responsibility-bar-guidance.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RESPONSIBILITY_BARS_TEST_DATABASE_URL");
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

const RANGE_PROPOSAL = {
  standard: "We always have between 12 and 24 months of runway.",
  metricKind: "range",
  metricName: "Runway",
  metricUnit: "months",
  metricLow: 12,
  metricHigh: 24,
  metricCurrent: 10,
  currentEvidence: "Cash on hand over the last three months' average burn",
  message: "This keeps runway in a healthy band.",
};

describeEmbeddedPostgres("responsibility bar templates and bar conversations", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wakeup: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-responsibility-bars-");
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
    app.use("/api", responsibilityBarRoutes(db, { heartbeat }));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const company = await db.insert(companies)
      .values({ name: "Bar Co", issuePrefix: `B${randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase()}` })
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
      title: "Finance", standard: "Runway stays comfortable", metricName: "Runway", metricUnit: "months", metricTarget: 12, metricCurrent: 14,
    });
    expect(created.status).toBe(201);
    return { company, ceo: ceo!, analyst: analyst!, app, responsibility: created.body as { id: string } };
  }

  async function actions(companyId: string) {
    return db.select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.companyId, companyId));
  }

  async function startConversation(seeded: Awaited<ReturnType<typeof seed>>, body: object = {}) {
    const res = await request(seeded.app).post(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`).send(body);
    return res;
  }

  async function propose(companyId: string, agentId: string, issueId: string, body: object = RANGE_PROPOSAL) {
    return request(createApp(agentActor(companyId, agentId))).post(`/api/issues/${issueId}/bar-proposals`).send(body);
  }

  describe("templates through the API", () => {
    it("creates and reads each template, with yes or no reported as true or false", async () => {
      const { company, app } = await seed();
      const post = (body: object) => request(app).post(`/api/companies/${company.id}/responsibilities`).send({ title: "T", standard: "Bar", ...body });
      const share = await post({ metricKind: "percentage", metricName: "Invoices paid on time", metricTarget: 90, metricCurrent: 70 });
      const pack = await post({ metricKind: "yes_no", metricName: "Board pack sent a week ahead", metricCurrent: false });
      const runway = await post({ metricKind: "range", metricName: "Runway", metricUnit: "months", metricLow: 12, metricHigh: 24, metricCurrent: 26 });
      for (const res of [share, pack, runway]) expect(res.status).toBe(201);
      expect(share.body).toMatchObject({ metricKind: "percentage", metricUnit: "%", metricDirection: "at_least" });
      expect(share.body.rollup).toMatchObject({ health: "at_risk", statusSentence: "Invoices paid on time: 70% against a target of at least 90%" });
      expect(pack.body).toMatchObject({ metricKind: "yes_no", metricCurrent: 0, metricTarget: null, metricDirection: null, metricUnit: null });
      expect(pack.body.rollup).toMatchObject({ health: "behind", statusSentence: "Board pack sent a week ahead: no, the bar is yes" });
      expect(runway.body).toMatchObject({ metricKind: "range", metricLow: 12, metricHigh: 24, metricTarget: null, metricDirection: null });
      expect(runway.body.rollup).toMatchObject({ health: "at_risk", statusSentence: "Runway: 26 months, 2 months above the range of 12 to 24 months" });
      expect(runway.body.rollup.metric).toMatchObject({ kind: "range", low: 12, high: 24, attainment: 0.8333 });

      const flipped = await request(app).patch(`/api/responsibilities/${pack.body.id}`).send({ metricCurrent: true });
      expect(flipped.status).toBe(200);
      expect(flipped.body).toMatchObject({ metricCurrent: 1, rollup: { health: "on_track" } });
      const wrongReading = await request(app).patch(`/api/responsibilities/${pack.body.id}`).send({ metricCurrent: 7 });
      expect(wrongReading.status).toBe(422);
      expect(wrongReading.body.error).toContain("true or false");
      expect((await request(app).patch(`/api/responsibilities/${share.body.id}`).send({ metricCurrent: 140 })).status).toBe(422);
      expect((await request(app).patch(`/api/responsibilities/${share.body.id}`).send({ metricCurrent: true })).status).toBe(422);

      const overview = await request(app).get(`/api/companies/${company.id}/responsibilities`);
      // The seeded volume (14 of 12, on track) plus these three.
      expect(overview.body.totals.byHealth).toEqual({ behind: 0, at_risk: 2, on_track: 2, not_measured: 0 });
    });

    it("lets the running agent report a yes or no as true or false", async () => {
      const { company, app, analyst } = await seed();
      const pack = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({
        title: "Board", standard: "Directors get the pack a week ahead", metricKind: "yes_no", metricName: "Board pack sent", runByAgentId: analyst.id,
      });
      const agentApp = createApp(agentActor(company.id, analyst.id));
      const yes = await request(agentApp).patch(`/api/responsibilities/${pack.body.id}`).send({ metricCurrent: true });
      expect(yes.status).toBe(200);
      expect(yes.body).toMatchObject({ metricCurrent: 1, rollup: { health: "on_track", statusSentence: "Board pack sent: yes" } });
      const logged = (await actions(company.id)).filter((entry) => entry.action === "responsibility.metric_updated");
      expect(logged.at(-1)?.details).toEqual({ metricName: "Board pack sent", from: null, to: 1 });
    });

    it("changes template by patch, clearing what the new template does not use", async () => {
      const { app, responsibility } = await seed();
      const toRange = await request(app).patch(`/api/responsibilities/${responsibility.id}`)
        .send({ metricKind: "range", metricLow: 12, metricHigh: 24 });
      expect(toRange.status).toBe(200);
      expect(toRange.body).toMatchObject({
        metricKind: "range", metricTarget: null, metricDirection: null, metricUnit: "months", metricLow: 12, metricHigh: 24, metricCurrent: null,
      });
      // A complete bar is required on an active responsibility.
      const incomplete = await request(app).patch(`/api/responsibilities/${responsibility.id}`).send({ metricKind: "volume" });
      expect(incomplete.status).toBe(422);
      expect(incomplete.body.error).toContain("needs a target");
      const mixed = await request(app).patch(`/api/responsibilities/${responsibility.id}`).send({ metricTarget: 5 });
      expect(mixed.status).toBe(422);
      expect(mixed.body.error).toContain("low and a high bound instead of a target");
      const toYesNo = await request(app).patch(`/api/responsibilities/${responsibility.id}`)
        .send({ metricKind: "yes_no", metricName: "Runway above a year", metricCurrent: true });
      expect(toYesNo.body).toMatchObject({ metricKind: "yes_no", metricUnit: null, metricLow: null, metricHigh: null, metricCurrent: 1 });
    });

    it("refuses to activate a responsibility without its template's inputs", async () => {
      const { company, app } = await seed();
      const draft = await request(app).post(`/api/companies/${company.id}/responsibilities`).send({
        title: "Ops", standard: "Stock stays healthy", metricKind: "range", metricName: "Weeks of stock", metricLow: 4, metricHigh: 8, status: "proposed",
      });
      expect(draft.status).toBe(201);
      expect((await request(app).patch(`/api/responsibilities/${draft.body.id}`).send({ metricHigh: null })).status).toBe(200);
      const refused = await request(app).patch(`/api/responsibilities/${draft.body.id}`).send({ status: "active" });
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual({ missing: ["metricHigh"], metricKind: "range" });
      expect(refused.body.error).toBe("A responsibility with a metric needs its bar (standard) and a metric name and a low and a high bound before it can be active; finish the bar or clear the metric");
      expect((await request(app).patch(`/api/responsibilities/${draft.body.id}`).send({ status: "active", metricHigh: 8 })).status).toBe(200);
    });

    it("reads a row saved before templates existed exactly as before, and leaves it unchanged on unrelated edits", async () => {
      const { company, app } = await seed();
      const [legacy] = await db.insert(responsibilities).values({
        companyId: company.id, ownerUserId: OWNER, title: "Updates", status: "active", standard: "Updates go out on time",
        metricName: "Updates sent on time", metricUnit: "%", metricTarget: 150, metricCurrent: 90, metricDirection: "at_least",
      }).returning();
      const detail = await request(app).get(`/api/responsibilities/${legacy!.id}`);
      expect(detail.body).toMatchObject({ metricKind: "percentage", metricLow: null, metricHigh: null });
      expect(detail.body.rollup.statusSentence).toBe("Updates sent on time: 90% against a target of at least 150%");
      // Unrelated edits and a reading do not trip rules the row predates.
      expect((await request(app).patch(`/api/responsibilities/${legacy!.id}`).send({ title: "Weekly updates" })).status).toBe(200);
      expect((await request(app).patch(`/api/responsibilities/${legacy!.id}`).send({ metricCurrent: 95 })).status).toBe(200);
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, legacy!.id));
      expect(row).toMatchObject({ metricKind: null, metricUnit: "%", metricTarget: 150, metricCurrent: 95 });
    });
  });

  describe("bar conversations", () => {
    it("is not available while the responsibilities experiment is off", async () => {
      const seeded = await seed();
      const started = await startConversation(seeded);
      expect(started.status).toBe(201);
      await instanceSettingsService(db).updateExperimental({ enableResponsibilities: false });
      const issueId = started.body.conversation.issueId as string;
      for (const res of [
        await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`),
        await startConversation(seeded),
        await propose(seeded.company.id, seeded.ceo.id, issueId),
        await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${randomUUID()}/accept`).send({}),
        await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${randomUUID()}/decline`).send({}),
      ]) {
        expect(res.status).toBe(404);
      }
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).toEqual([]);
    });

    it("opens one conversation with the default agent, wakes it, and reopens the same one", async () => {
      const seeded = await seed();
      const before = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(before.body).toMatchObject({ state: "none", defaultAgentId: seeded.ceo.id, conversation: null, proposal: null });

      const started = await startConversation(seeded);
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ state: "discussing", conversation: { agentId: seeded.ceo.id, title: "Edit the bar for Finance" } });
      const issueId = started.body.conversation.issueId as string;
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task).toMatchObject({
        originKind: "responsibility_bar", originId: seeded.responsibility.id, assigneeAgentId: seeded.ceo.id, createdByUserId: OWNER, status: "todo",
      });
      expect(task!.description).toContain(`/responsibilities/${seeded.responsibility.id})`);
      expect(wakeup).toHaveBeenCalledWith(seeded.ceo.id, expect.objectContaining({ payload: expect.objectContaining({ issueId }) }));
      const logged = (await actions(seeded.company.id)).map((entry) => entry.action);
      expect(logged).toEqual(expect.arrayContaining(["issue.created", "responsibility.bar_conversation_started"]));

      const again = await startConversation(seeded, { agentId: seeded.analyst.id });
      expect(again.status).toBe(200);
      expect(again.body.conversation.issueId).toBe(issueId);
      // Only the owner or an admin opens it.
      const otherApp = createApp(sessionBoardActor(seeded.company.id, OTHER));
      expect((await request(otherApp).post(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`).send({})).status).toBe(403);
      // The runner is the default once there is one.
      await request(seeded.app).patch(`/api/responsibilities/${seeded.responsibility.id}`).send({ runByAgentId: seeded.analyst.id });
      const after = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(after.body.defaultAgentId).toBe(seeded.analyst.id);
    });

    it("offers the hand-edit path when no agent can hold the conversation", async () => {
      const seeded = await seed();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.companyId, seeded.company.id));
      const state = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(state.body.defaultAgentId).toBeNull();
      const refused = await startConversation(seeded);
      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain("responsibility_bar_no_agent");
    });

    it("lets only the agent in the conversation propose, validates the bar, and writes nothing to the responsibility", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      expect((await propose(seeded.company.id, seeded.analyst.id, issueId)).status).toBe(403);
      expect((await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals`).send(RANGE_PROPOSAL)).status).toBe(403);
      // An agent from another company cannot reach it.
      const elsewhere = await seed();
      expect((await propose(elsewhere.company.id, elsewhere.ceo.id, issueId)).status).toBe(404);
      // A task that is not a bar conversation cannot carry a proposal.
      const [plain] = await db.insert(issues).values({
        companyId: seeded.company.id, title: "Plain", status: "todo", priority: "medium", assigneeAgentId: seeded.ceo.id,
      }).returning();
      expect((await propose(seeded.company.id, seeded.ceo.id, plain!.id)).status).toBe(422);
      // Validation against the template.
      const invalid = await propose(seeded.company.id, seeded.ceo.id, issueId, { ...RANGE_PROPOSAL, metricHigh: 6 });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(invalid.body)).toContain("must be above its low bound");
      expect((await propose(seeded.company.id, seeded.ceo.id, issueId, { ...RANGE_PROPOSAL, currentEvidence: undefined })).status).toBe(400);
      expect((await propose(seeded.company.id, seeded.ceo.id, issueId, { ...RANGE_PROPOSAL, metricTarget: 12 })).status).toBe(400);

      const res = await propose(seeded.company.id, seeded.ceo.id, issueId);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: "propose_responsibility_bar",
        status: "pending",
        continuationPolicy: "none",
        effectiveResolverPolicy: "human_only",
        payload: {
          responsibilityId: seeded.responsibility.id,
          templateLabel: "Range",
          targetLabel: "Between 12 and 24 months",
          readingLabel: "10 months",
          statusRule: "On track between 12 and 24 months; at risk up to 3 months outside it; behind further out",
          preview: { health: "at_risk", statusSentence: "Runway: 10 months, 2 months below the range of 12 to 24 months" },
          bar: { metricKind: "range", metricTarget: null, metricDirection: null },
        },
      });
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.responsibility.id));
      expect(row).toMatchObject({ metricKind: "volume", metricTarget: 12, metricCurrent: 14, metricLow: null });
      const state = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(state.body).toMatchObject({ state: "proposal_waiting", proposal: { id: res.body.id } });
    });

    it("keeps one proposal pending at a time: a new one replaces the old", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const first = await propose(seeded.company.id, seeded.ceo.id, issueId);
      const second = await propose(seeded.company.id, seeded.ceo.id, issueId, {
        standard: "Runway never drops under a year.", metricKind: "volume", metricName: "Runway", metricUnit: "months", metricTarget: 12,
      });
      expect(second.status).toBe(201);
      const [old] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, first.body.id));
      expect(old).toMatchObject({ status: "expired", result: { outcome: "replaced", replacedByInteractionId: second.body.id } });
      const pending = await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.status, "pending"),
      ));
      expect(pending.map((entry) => entry.id)).toEqual([second.body.id]);
      expect((await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${first.body.id}/accept`).send({})).status).toBe(409);
    });

    it("applies an accepted bar atomically, only for a writer, and records it", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const offered = await propose(seeded.company.id, seeded.ceo.id, issueId);
      const accept = (actor: Actor) => request(createApp(actor)).post(`/api/issues/${issueId}/bar-proposals/${offered.body.id}/accept`).send({});

      expect((await accept(agentActor(seeded.company.id, seeded.ceo.id))).status).toBe(403);
      expect((await accept(sessionBoardActor(seeded.company.id, OTHER))).status).toBe(403);
      // An admin who does not own it may.
      const res = await accept(sessionBoardActor(seeded.company.id, OTHER, "admin"));
      expect(res.status).toBe(200);
      expect(res.body.interaction).toMatchObject({ status: "accepted", resolvedByUserId: OTHER, result: { outcome: "accepted", responsibilityId: seeded.responsibility.id } });
      expect(res.body.responsibility).toMatchObject({
        id: seeded.responsibility.id,
        standard: RANGE_PROPOSAL.standard,
        metricKind: "range",
        metricLow: 12,
        metricHigh: 24,
        metricTarget: null,
        metricDirection: null,
        metricCurrent: 10,
        rollup: { health: "at_risk" },
      });
      const logged = await actions(seeded.company.id);
      const barUpdated = logged.find((entry) => entry.action === "responsibility.bar_updated");
      expect(barUpdated).toMatchObject({ entityId: seeded.responsibility.id });
      expect(barUpdated!.details).toMatchObject({
        fromMetricKind: "volume", toMetricKind: "range", issueId, interactionId: offered.body.id,
        fields: expect.arrayContaining(["standard", "metricKind", "metricTarget", "metricLow", "metricHigh"]),
      });
      expect(logged.map((entry) => entry.action)).toEqual(expect.arrayContaining(["responsibility.metric_updated", "issue.thread_interaction_accepted"]));
      // Settled: a second accept changes nothing, and the page no longer reads it as being discussed.
      expect((await accept(localBoardActor())).status).toBe(409);
      const state = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(state.body).toMatchObject({ state: "settled", proposal: null });
    });

    it("rolls the card back when the bar cannot be applied", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const offered = await propose(seeded.company.id, seeded.ceo.id, issueId);
      await db.update(responsibilities).set({ status: "dismissed" }).where(eq(responsibilities.id, seeded.responsibility.id));
      const res = await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${offered.body.id}/accept`).send({});
      expect(res.status).toBe(409);
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, offered.body.id));
      expect(card).toMatchObject({ status: "pending", result: null });
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.responsibility.id));
      expect(row).toMatchObject({ metricKind: "volume", metricTarget: 12 });
    });

    it("declining leaves the bar alone and the conversation continues", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const offered = await propose(seeded.company.id, seeded.ceo.id, issueId);
      expect((await request(createApp(sessionBoardActor(seeded.company.id, OTHER)))
        .post(`/api/issues/${issueId}/bar-proposals/${offered.body.id}/decline`).send({})).status).toBe(403);
      const declined = await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${offered.body.id}/decline`).send({});
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({ status: "rejected", result: { outcome: "declined" } });
      const [row] = await db.select().from(responsibilities).where(eq(responsibilities.id, seeded.responsibility.id));
      expect(row).toMatchObject({ metricKind: "volume", metricTarget: 12, metricCurrent: 14 });
      const state = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(state.body).toMatchObject({ state: "discussing", proposal: null });
      // The agent can propose again.
      expect((await propose(seeded.company.id, seeded.ceo.id, issueId)).status).toBe(201);
    });

    it("keeps a proposal open after the agent finishes the conversation, and withdraws it when cancelled", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const offered = await propose(seeded.company.id, seeded.ceo.id, issueId);
      const interactions = issueThreadInteractionService(db);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      await interactions.expirePendingInteractionsForTerminalIssue({ id: issueId, companyId: seeded.company.id, status: "done" });
      expect((await interactions.listForIssue(issueId)).map((entry) => entry.status)).toEqual(["pending"]);
      // A done conversation with a proposal waiting is still the one to open.
      expect((await startConversation(seeded)).status).toBe(200);
      expect((await request(seeded.app).post(`/api/issues/${issueId}/bar-proposals/${offered.body.id}/accept`).send({})).status).toBe(200);
      const settled = await request(seeded.app).get(`/api/responsibilities/${seeded.responsibility.id}/bar-conversation`);
      expect(settled.body.state).toBe("settled");

      // Cancelling withdraws a waiting proposal and blocks new ones.
      const next = await startConversation(seeded);
      expect(next.status).toBe(201);
      const nextIssueId = next.body.conversation.issueId as string;
      const waiting = await propose(seeded.company.id, seeded.ceo.id, nextIssueId);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, nextIssueId));
      await interactions.expirePendingInteractionsForTerminalIssue({ id: nextIssueId, companyId: seeded.company.id, status: "cancelled" });
      const [withdrawn] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, waiting.body.id));
      expect(withdrawn!.status).toBe("expired");
      expect((await propose(seeded.company.id, seeded.ceo.id, nextIssueId)).status).toBe(409);
    });

    it("gives the agent its instructions only in its own bar conversation", async () => {
      const seeded = await seed();
      const issueId = (await startConversation(seeded)).body.conversation.issueId as string;
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const issue = { id: task!.id, companyId: task!.companyId, originKind: task!.originKind, originId: task!.originId, assigneeAgentId: task!.assigneeAgentId };
      const guidance = await loadResponsibilityBarGuidance(db, { issue, agentId: seeded.ceo.id });
      expect(guidance).toContain("- Title: Finance");
      expect(guidance).toContain("- Bar today: \"Runway stays comfortable\"; Volume: Runway (at least 12 months); reading 14 months");
      expect(guidance).toContain(`POST /api/issues/${issueId}/bar-proposals`);
      expect(await loadResponsibilityBarGuidance(db, { issue, agentId: seeded.analyst.id })).toBeNull();
      expect(await loadResponsibilityBarGuidance(db, { issue: { ...issue, originKind: "manual" }, agentId: seeded.ceo.id })).toBeNull();

      await propose(seeded.company.id, seeded.ceo.id, issueId);
      const later = await loadResponsibilityBarGuidance(db, { issue, agentId: seeded.ceo.id });
      expect(later).toContain(`"${RANGE_PROPOSAL.standard}" (Range: Between 12 and 24 months): waiting for the person`);
    });
  });
});
