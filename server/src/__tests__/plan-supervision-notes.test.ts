/**
 * Integration tests for plan-supervision-notes service and related routes.
 *
 * Covers: addSupervisionNote, listSupervisionNotes, tickPlanMonitoring,
 * monitorNow, GET/POST /supervision-notes, POST /supervision/monitor.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  planDetails,
  planSupervisionNotes,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  addSupervisionNote,
  listSupervisionNotes,
  monitorNow,
  SUPERVISION_MONITOR_INTERVAL_MS,
  tickPlanMonitoring,
} from "../services/plan-supervision-notes.js";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plan-supervision-notes tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plan supervision notes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-supervision-notes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(planSupervisionNotes);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeWakeup() {
    return vi.fn().mockResolvedValue(null);
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedCtoAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "engineering-manager",
      urlKey: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  async function seedPlan(
    companyId: string,
    opts: {
      state?: string;
      lastMonitoredAt?: Date | null;
      assigneeAgentId?: string | null;
    } = {},
  ) {
    const rootId = randomUUID();
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Test Plan",
      workMode: "planning",
      status: "in_progress",
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
    await db.insert(planDetails).values({
      issueId: rootId,
      companyId,
      state: opts.state ?? "active",
      lastMonitoredAt: opts.lastMonitoredAt !== undefined ? opts.lastMonitoredAt : null,
    });
    return rootId;
  }

  // ─── Service unit tests ────────────────────────────────────────────────────

  describe("addSupervisionNote", () => {
    it("persists a note and returns it", async () => {
      const companyId = await seedCompany();
      const planIssueId = await seedPlan(companyId);

      const note = await addSupervisionNote(db, {
        planIssueId,
        companyId,
        kind: "observation",
        severity: "info",
        body: "All agents working normally.",
      });

      expect(note.id).toBeDefined();
      expect(note.body).toBe("All agents working normally.");
      expect(note.kind).toBe("observation");
      expect(note.severity).toBe("info");
    });
  });

  describe("listSupervisionNotes", () => {
    it("returns notes in descending order by createdAt", async () => {
      const companyId = await seedCompany();
      const planIssueId = await seedPlan(companyId);

      await addSupervisionNote(db, { planIssueId, companyId, kind: "observation", body: "First" });
      await addSupervisionNote(db, { planIssueId, companyId, kind: "observation", body: "Second" });

      const notes = await listSupervisionNotes(db, planIssueId);
      expect(notes.length).toBe(2);
      // Most recent first
      expect(notes[0].body).toBe("Second");
      expect(notes[1].body).toBe("First");
    });

    it("only returns notes for the specified plan", async () => {
      const companyId = await seedCompany();
      const planA = await seedPlan(companyId);
      const planB = await seedPlan(companyId);

      await addSupervisionNote(db, { planIssueId: planA, companyId, kind: "observation", body: "A note" });
      await addSupervisionNote(db, { planIssueId: planB, companyId, kind: "observation", body: "B note" });

      const notesA = await listSupervisionNotes(db, planA);
      expect(notesA.length).toBe(1);
      expect(notesA[0].body).toBe("A note");
    });
  });

  describe("tickPlanMonitoring", () => {
    it("wakes CTO for an active plan with no lastMonitoredAt", async () => {
      const companyId = await seedCompany();
      const ctoId = await seedCtoAgent(companyId);
      const planId = await seedPlan(companyId, { lastMonitoredAt: null });
      const wakeup = makeWakeup();

      const result = await tickPlanMonitoring(db, { wakeup });

      expect(result.woken).toBe(1);
      expect(wakeup).toHaveBeenCalledOnce();
      expect(wakeup).toHaveBeenCalledWith(ctoId, expect.objectContaining({
        reason: "plan_monitor",
        source: "timer",
        payload: expect.objectContaining({ planIssueId: planId }),
      }));

      const [row] = await db.select({ lastMonitoredAt: planDetails.lastMonitoredAt })
        .from(planDetails)
        .where(eq(planDetails.issueId, planId));
      expect(row?.lastMonitoredAt).not.toBeNull();
    });

    it("wakes CTO for a plan whose lastMonitoredAt is past the interval", async () => {
      const companyId = await seedCompany();
      await seedCtoAgent(companyId);
      const staleMonitored = new Date(Date.now() - SUPERVISION_MONITOR_INTERVAL_MS - 60_000);
      await seedPlan(companyId, { lastMonitoredAt: staleMonitored });
      const wakeup = makeWakeup();

      const result = await tickPlanMonitoring(db, { wakeup });
      expect(result.woken).toBe(1);
    });

    it("does NOT wake CTO for a plan recently monitored", async () => {
      const companyId = await seedCompany();
      await seedCtoAgent(companyId);
      const recentMonitored = new Date(Date.now() - 60_000); // 1 min ago
      await seedPlan(companyId, { lastMonitoredAt: recentMonitored });
      const wakeup = makeWakeup();

      const result = await tickPlanMonitoring(db, { wakeup });
      expect(result.woken).toBe(0);
      expect(wakeup).not.toHaveBeenCalled();
    });

    it("skips non-active plans", async () => {
      const companyId = await seedCompany();
      await seedCtoAgent(companyId);
      await seedPlan(companyId, { state: "stopped", lastMonitoredAt: null });
      const wakeup = makeWakeup();

      const result = await tickPlanMonitoring(db, { wakeup });
      expect(result.woken).toBe(0);
    });

    it("sets lastMonitoredAt even when no CTO agent found", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId, { lastMonitoredAt: null });
      const wakeup = makeWakeup();

      const result = await tickPlanMonitoring(db, { wakeup });
      expect(result.woken).toBe(0);
      expect(wakeup).not.toHaveBeenCalled();

      const [row] = await db.select({ lastMonitoredAt: planDetails.lastMonitoredAt })
        .from(planDetails)
        .where(eq(planDetails.issueId, planId));
      expect(row?.lastMonitoredAt).not.toBeNull();
    });

    it("does not wake again on immediate re-tick (lastMonitoredAt blocks)", async () => {
      const companyId = await seedCompany();
      await seedCtoAgent(companyId);
      await seedPlan(companyId, { lastMonitoredAt: null });
      const wakeup = makeWakeup();

      await tickPlanMonitoring(db, { wakeup });
      wakeup.mockClear();
      await tickPlanMonitoring(db, { wakeup });

      expect(wakeup).not.toHaveBeenCalled();
    });
  });

  describe("monitorNow", () => {
    it("wakes CTO immediately regardless of interval", async () => {
      const companyId = await seedCompany();
      const ctoId = await seedCtoAgent(companyId);
      const recentMonitored = new Date(Date.now() - 60_000); // within normal interval
      const planId = await seedPlan(companyId, { lastMonitoredAt: recentMonitored });
      const wakeup = makeWakeup();

      const result = await monitorNow(db, { wakeup }, planId);

      expect(result.woken).toBe(true);
      expect(wakeup).toHaveBeenCalledOnce();
      expect(wakeup).toHaveBeenCalledWith(ctoId, expect.objectContaining({
        reason: "plan_monitor",
        source: "on_demand",
      }));
    });

    it("throws 409 when plan is not active", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId, { state: "stopped" });
      const wakeup = makeWakeup();

      await expect(monitorNow(db, { wakeup }, planId)).rejects.toMatchObject({
        status: 409,
        message: "Plan is not active",
      });
    });
  });

  // ─── Route integration tests ───────────────────────────────────────────────

  let actor: Record<string, unknown> = {};

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", planRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function asBoardOf(companyId: string) {
    actor = { type: "board", userId: "test-user", companyId, source: "local_implicit" };
  }

  function asAgentOf(companyId: string) {
    actor = { type: "agent", companyId, agentId: randomUUID(), runId: null };
  }

  describe("GET /api/plans/:issueId/supervision-notes", () => {
    it("returns notes for the plan", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      await addSupervisionNote(db, { planIssueId: planId, companyId, kind: "observation", body: "Note A" });
      asBoardOf(companyId);

      const res = await request(buildApp())
        .get(`/api/plans/${planId}/supervision-notes`);

      expect(res.status).toBe(200);
      expect(res.body.notes).toHaveLength(1);
      expect(res.body.notes[0].body).toBe("Note A");
    });

    it("returns 404 for unknown plan", async () => {
      const companyId = await seedCompany();
      asBoardOf(companyId);
      const res = await request(buildApp())
        .get(`/api/plans/${randomUUID()}/supervision-notes`);
      expect(res.status).toBe(404);
    });

    it("returns 403 for cross-company request", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const planId = await seedPlan(companyA);
      asAgentOf(companyB);

      const res = await request(buildApp())
        .get(`/api/plans/${planId}/supervision-notes`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/plans/:issueId/supervision-notes", () => {
    it("creates a note and returns 201", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(`/api/plans/${planId}/supervision-notes`)
        .send({ kind: "observation", severity: "warning", body: "Agent looks stuck." });

      expect(res.status).toBe(201);
      expect(res.body.note.kind).toBe("observation");
      expect(res.body.note.severity).toBe("warning");
    });

    it("returns 400 for invalid body", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(`/api/plans/${planId}/supervision-notes`)
        .send({ kind: "unknown_kind", body: "test" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/plans/:issueId/supervision/monitor", () => {
    it("returns 404 for unknown plan", async () => {
      const companyId = await seedCompany();
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(`/api/plans/${randomUUID()}/supervision/monitor`)
        .send({});

      expect(res.status).toBe(404);
    });

    it("returns 409 for non-active plan", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId, { state: "stopped" });
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(`/api/plans/${planId}/supervision/monitor`)
        .send({});

      expect(res.status).toBe(409);
    });
  });
});
