/**
 * Dashboard Observability Integration Tests — CLI-196
 *
 * Covers all three dashboard surfaces end-to-end with a real embedded Postgres
 * database to verify the full pipeline: emit events → logging stack persists
 * them → dashboard queries return correct aggregated data.
 *
 * Three surfaces under test:
 *   1. Main Dashboard     GET /companies/:companyId/dashboard
 *   2. Activity Dashboard GET /companies/:companyId/activity
 *   3. Sidebar Badges     GET /companies/:companyId/sidebar-badges
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { activityRoutes } from "../routes/activity.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dashboard integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function makeCompanyRow() {
  const id = randomUUID();
  return {
    id,
    name: "TestCorp",
    issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  };
}

function makeAgentRow(companyId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    companyId,
    name: "TestAgent",
    role: "engineer",
    status: "running",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    ...overrides,
  } as const;
}

describeEmbeddedPostgres("dashboard observability integration", () => {
  type Db = ReturnType<typeof createDb>;
  let db!: Db;
  let app!: express.Express;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-integration-");
    db = createDb(tempDb.connectionString);

    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      // local_implicit board bypasses company membership and permission checks.
      (req as any).actor = {
        type: "board",
        userId: "test-board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [],
      };
      next();
    });
    expressApp.use("/api", dashboardRoutes(db));
    expressApp.use("/api", activityRoutes(db));
    expressApp.use("/api", sidebarBadgeRoutes(db));
    expressApp.use(errorHandler);
    app = expressApp;
  }, 30_000);

  afterEach(async () => {
    // Delete in dependency order to satisfy FK constraints.
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(budgetIncidents); // refs budgetPolicies + approvals
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. MAIN DASHBOARD — GET /companies/:companyId/dashboard
  // ────────────────────────────────────────────────────────────────────────────

  describe("main dashboard — GET /companies/:companyId/dashboard", () => {
    it("returns a zero-state summary for a fresh company", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        companyId: company.id,
        agents: { active: 0, running: 0, paused: 0, error: 0 },
        tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
        costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
        pendingApprovals: 0,
      });
      expect(res.body.runActivity).toHaveLength(14);
      expect(res.body.runActivity.every((b: { total: number }) => b.total === 0)).toBe(true);
    });

    it("reflects emitted heartbeat runs in the 14-day run activity window", async () => {
      const company = makeCompanyRow();
      const agent = makeAgentRow(company.id);
      await db.insert(companies).values(company);
      await db.insert(agents).values(agent);

      const today = new Date();
      await db.insert(heartbeatRuns).values([
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "succeeded", createdAt: today },
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "failed", createdAt: today },
        // timed_out must bucket into "failed"
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "timed_out", createdAt: today },
        // cancelled must bucket into "other"
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "cancelled", createdAt: today },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      const todayKey = today.toISOString().slice(0, 10);
      const todayBucket = res.body.runActivity.find((b: { date: string }) => b.date === todayKey);
      expect(todayBucket).toMatchObject({ succeeded: 1, failed: 2, other: 1, total: 4 });
    });

    it("counts idle agents as active (not as a separate bucket)", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(agents).values([
        makeAgentRow(company.id, { name: "A1", status: "idle" }),
        makeAgentRow(company.id, { name: "A2", status: "running" }),
        makeAgentRow(company.id, { name: "A3", status: "paused" }),
        makeAgentRow(company.id, { name: "A4", status: "error" }),
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body.agents).toMatchObject({ active: 1, running: 1, paused: 1, error: 1 });
    });

    it("aggregates task counts and excludes cancelled from the open bucket", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(issues).values([
        { id: randomUUID(), companyId: company.id, title: "T-todo", status: "todo", priority: "medium" },
        { id: randomUUID(), companyId: company.id, title: "T-in_progress", status: "in_progress", priority: "medium" },
        { id: randomUUID(), companyId: company.id, title: "T-blocked", status: "blocked", priority: "medium" },
        { id: randomUUID(), companyId: company.id, title: "T-done", status: "done", priority: "medium" },
        // cancelled must not appear in any open counter
        { id: randomUUID(), companyId: company.id, title: "T-cancelled", status: "cancelled", priority: "medium" },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      // open = todo + in_progress + blocked (not done, not cancelled)
      expect(res.body.tasks).toMatchObject({ open: 3, inProgress: 1, blocked: 1, done: 1 });
    });

    it("reflects emitted cost events in monthly spend", async () => {
      const company = makeCompanyRow();
      const agent = makeAgentRow(company.id);
      await db.insert(companies).values(company);
      await db.insert(agents).values(agent);

      const now = new Date();
      await db.insert(costEvents).values([
        {
          companyId: company.id,
          agentId: agent.id,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered",
          model: "claude-sonnet",
          inputTokens: 100,
          outputTokens: 50,
          costCents: 150,
          occurredAt: now,
        },
        {
          companyId: company.id,
          agentId: agent.id,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered",
          model: "claude-sonnet",
          inputTokens: 200,
          outputTokens: 100,
          costCents: 300,
          occurredAt: now,
        },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body.costs.monthSpendCents).toBe(450);
    });

    it("counts pending approvals correctly", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(approvals).values([
        { id: randomUUID(), companyId: company.id, type: "request_board_approval", status: "pending", payload: {} },
        { id: randomUUID(), companyId: company.id, type: "request_board_approval", status: "approved", payload: {} },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body.pendingApprovals).toBe(1);
    });

    it("isolates all data between companies", async () => {
      const companyA = makeCompanyRow();
      const companyB = makeCompanyRow();
      const agentB = makeAgentRow(companyB.id);
      await db.insert(companies).values([companyA, companyB]);
      await db.insert(agents).values(agentB);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: companyB.id,
        agentId: agentB.id,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date(),
      });
      await db.insert(issues).values({
        id: randomUUID(),
        companyId: companyB.id,
        title: "B task",
        status: "in_progress",
        priority: "medium",
      });

      const res = await request(app).get(`/api/companies/${companyA.id}/dashboard`);

      expect(res.status).toBe(200);
      expect(res.body.agents.running).toBe(0);
      expect(res.body.tasks.inProgress).toBe(0);
      expect(res.body.runActivity.every((b: { total: number }) => b.total === 0)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. ACTIVITY DASHBOARD — GET /companies/:companyId/activity
  // ────────────────────────────────────────────────────────────────────────────

  describe("activity dashboard — GET /companies/:companyId/activity", () => {
    it("returns an empty array for a fresh company", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);

      const res = await request(app).get(`/api/companies/${company.id}/activity`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("emitting an event via POST /activity makes it visible in GET /activity", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);

      // Emit event through the real HTTP route (the "emit" path).
      const emitRes = await request(app)
        .post(`/api/companies/${company.id}/activity`)
        .send({
          actorId: "test-emitter",
          action: "test.integration.event",
          entityType: "issue",
          entityId: "issue-abc",
        });
      expect(emitRes.status).toBe(201);
      expect(emitRes.body).toMatchObject({
        action: "test.integration.event",
        entityType: "issue",
        entityId: "issue-abc",
      });

      // Verify the logging stack received and persisted it.
      const listRes = await request(app).get(`/api/companies/${company.id}/activity`);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);
      expect(listRes.body[0]).toMatchObject({
        action: "test.integration.event",
        entityType: "issue",
        entityId: "issue-abc",
        companyId: company.id,
      });
    });

    it("returns events newest-first", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(activityLog).values([
        { companyId: company.id, actorType: "system", actorId: "sys", action: "first.event", entityType: "company", entityId: company.id, createdAt: new Date("2026-04-01T10:00:00.000Z") },
        { companyId: company.id, actorType: "system", actorId: "sys", action: "third.event", entityType: "company", entityId: company.id, createdAt: new Date("2026-04-01T12:00:00.000Z") },
        { companyId: company.id, actorType: "system", actorId: "sys", action: "second.event", entityType: "company", entityId: company.id, createdAt: new Date("2026-04-01T11:00:00.000Z") },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/activity`);

      expect(res.status).toBe(200);
      expect(res.body.map((e: { action: string }) => e.action)).toEqual([
        "third.event",
        "second.event",
        "first.event",
      ]);
    });

    it("filters activity by entityType query param", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(activityLog).values([
        { companyId: company.id, actorType: "system", actorId: "sys", action: "issue.created", entityType: "issue", entityId: "issue-1" },
        { companyId: company.id, actorType: "system", actorId: "sys", action: "agent.created", entityType: "agent", entityId: "agent-1" },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/activity?entityType=issue`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].entityType).toBe("issue");
      expect(res.body[0].action).toBe("issue.created");
    });

    it("suppresses activity log entries for hidden issues from the list", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      const hiddenIssueId = randomUUID();
      await db.insert(issues).values({
        id: hiddenIssueId,
        companyId: company.id,
        title: "Hidden issue",
        status: "done",
        priority: "medium",
        hiddenAt: new Date(),
      });
      await db.insert(activityLog).values([
        // This entry references a hidden issue — must be suppressed.
        { companyId: company.id, actorType: "system", actorId: "sys", action: "issue.updated", entityType: "issue", entityId: hiddenIssueId },
        // This non-issue entry must still appear.
        { companyId: company.id, actorType: "system", actorId: "sys", action: "company.setting.changed", entityType: "company", entityId: company.id },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/activity`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].action).toBe("company.setting.changed");
    });

    it("caps the response at the requested limit", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(activityLog).values(
        Array.from({ length: 5 }, (_, i) => ({
          companyId: company.id,
          actorType: "system" as const,
          actorId: "sys",
          action: `event.${i}`,
          entityType: "company",
          entityId: company.id,
        })),
      );

      const res = await request(app).get(`/api/companies/${company.id}/activity?limit=3`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
    });

    it("isolates activity log entries between companies", async () => {
      const companyA = makeCompanyRow();
      const companyB = makeCompanyRow();
      await db.insert(companies).values([companyA, companyB]);
      await db.insert(activityLog).values({
        companyId: companyB.id,
        actorType: "system",
        actorId: "sys",
        action: "other.company.event",
        entityType: "company",
        entityId: companyB.id,
      });

      const res = await request(app).get(`/api/companies/${companyA.id}/activity`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. SIDEBAR BADGES — GET /companies/:companyId/sidebar-badges
  // ────────────────────────────────────────────────────────────────────────────

  describe("sidebar badges — GET /companies/:companyId/sidebar-badges", () => {
    it("returns all-zero badges for a fresh company", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        inbox: 0,
        approvals: 0,
        failedRuns: 0,
        joinRequests: 0,
      });
    });

    it("counts failed latest-run-per-agent as one failed run badge", async () => {
      const company = makeCompanyRow();
      const agent = makeAgentRow(company.id);
      await db.insert(companies).values(company);
      await db.insert(agents).values(agent);
      // Two failed runs for the same agent — only the latest counts (per-agent logic).
      await db.insert(heartbeatRuns).values([
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "failed", createdAt: new Date("2026-04-22T12:00:00.000Z") },
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "failed", createdAt: new Date("2026-04-21T12:00:00.000Z") },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      // The latest run is failed, so one agent is in failed state.
      expect(res.body.failedRuns).toBe(1);
    });

    it("clears the failed run badge when the latest run for an agent succeeded", async () => {
      const company = makeCompanyRow();
      const agent = makeAgentRow(company.id);
      await db.insert(companies).values(company);
      await db.insert(agents).values(agent);
      await db.insert(heartbeatRuns).values([
        // Latest run succeeded → no badge.
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "succeeded", createdAt: new Date("2026-04-22T13:00:00.000Z") },
        // Earlier run failed — must not trigger the badge.
        { id: randomUUID(), companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "failed", createdAt: new Date("2026-04-22T12:00:00.000Z") },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      expect(res.body.failedRuns).toBe(0);
    });

    it("ignores failed runs from terminated agents", async () => {
      const company = makeCompanyRow();
      const agent = makeAgentRow(company.id, { name: "Terminated", status: "terminated" });
      await db.insert(companies).values(company);
      await db.insert(agents).values(agent);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        status: "failed",
        createdAt: new Date(),
      });

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      expect(res.body.failedRuns).toBe(0);
    });

    it("counts only actionable (pending) approvals", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(approvals).values([
        { id: randomUUID(), companyId: company.id, type: "request_board_approval", status: "pending", payload: {} },
        // revision_requested is also actionable
        { id: randomUUID(), companyId: company.id, type: "request_board_approval", status: "revision_requested", payload: {} },
        // approved is terminal — must not count
        { id: randomUUID(), companyId: company.id, type: "request_board_approval", status: "approved", payload: {} },
      ]);

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      expect(res.body.approvals).toBe(2);
      expect(res.body.inbox).toBeGreaterThanOrEqual(2);
    });

    it("includes error agent alert in inbox when no failed run exists", async () => {
      const company = makeCompanyRow();
      await db.insert(companies).values(company);
      await db.insert(agents).values(makeAgentRow(company.id, { name: "ErrorAgent", status: "error" }));

      const res = await request(app).get(`/api/companies/${company.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      // No failed runs → the agent-in-error alert contributes 1 to inbox.
      expect(res.body.failedRuns).toBe(0);
      expect(res.body.inbox).toBeGreaterThanOrEqual(1);
    });

    it("isolates badge counts between companies", async () => {
      const companyA = makeCompanyRow();
      const companyB = makeCompanyRow();
      const agentB = makeAgentRow(companyB.id);
      await db.insert(companies).values([companyA, companyB]);
      await db.insert(agents).values(agentB);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: companyB.id,
        agentId: agentB.id,
        invocationSource: "assignment",
        status: "failed",
        createdAt: new Date(),
      });

      const res = await request(app).get(`/api/companies/${companyA.id}/sidebar-badges`);

      expect(res.status).toBe(200);
      expect(res.body.failedRuns).toBe(0);
      expect(res.body.inbox).toBe(0);
    });
  });
});
