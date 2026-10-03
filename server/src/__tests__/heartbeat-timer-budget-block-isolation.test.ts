import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat budget-block isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A budget-blocked agent must not abort the whole scheduler tick.
 *
 * enqueueWakeup throws `conflict(...)` when budgets.getInvocationBlock reports a
 * block. That throw is correct for the HTTP wake route (it becomes a 409), but
 * tickTimers awaits enqueueWakeup inside its agent loop, so an unguarded throw
 * aborts every remaining agent *and* skips tickDueIssueMonitors entirely.
 *
 * Note which branch of getInvocationBlock is reachable from here: the
 * `status === "paused" && pauseReason === "budget"` branch is not, because
 * tickTimers filters paused agents via evaluateAgentInvokability before ever
 * calling enqueueWakeup. The reachable branch — and the one that took the fleet
 * down for ~80h — is the agent-policy hard-stop, which fires while the agent is
 * still `status: "active"`.
 */
describeEmbeddedPostgres("heartbeat timer budget-block isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const LAST_HEARTBEAT = new Date("2026-04-11T12:00:00.000Z");
  const TICK_AT = new Date("2026-04-11T12:10:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hb-budget-block-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for heartbeat runs to settle");
  }

  // FK-ordered, mirroring issue-monitor-scheduler.test.ts: a healthy agent
  // really does spawn a run here, so its activity_log / lease rows must go
  // before heartbeat_runs.
  async function cleanupRows() {
    await waitForHeartbeatIdle();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
      lastHeartbeatAt: LAST_HEARTBEAT,
    });
    return agentId;
  }

  /**
   * Reproduces the production shape: the agent stays `active` (a budget stop
   * latches `pauseReason`, not `status`), while observed spend sits just over
   * the cap — the real incident was a $0.44 overrun on a $150.00 cap.
   */
  async function seedExceededBudget(companyId: string, agentId: string) {
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 15_000,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      projectId: null,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "budget-block-fixture",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      costCents: 15_044,
      occurredAt: new Date("2026-04-11T11:00:00.000Z"),
    });
  }

  it("still enqueues healthy agents when a budget-blocked agent is due in the same tick", async () => {
    const companyId = await seedCompany();
    // Seeded first so a seq scan reaches it first: pre-fix, this agent's throw
    // aborts the loop before the healthy agent is ever considered.
    const blockedAgentId = await seedAgent(companyId, "Budget Blocked Agent");
    await seedExceededBudget(companyId, blockedAgentId);
    const healthyAgentId = await seedAgent(companyId, "Healthy Agent");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const result = await heartbeat.tickTimers(TICK_AT);

    // The tick completes rather than rejecting, and the blocked agent is
    // accounted as skipped instead of taking the scan down with it.
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    await waitForHeartbeatIdle();

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, healthyAgentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const blockedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, blockedAgentId));
    expect(blockedRuns).toHaveLength(0);
  }, 30_000);

  it("records the budget skip and leaves the hard-stop enforced", async () => {
    const companyId = await seedCompany();
    const blockedAgentId = await seedAgent(companyId, "Budget Blocked Agent");
    await seedExceededBudget(companyId, blockedAgentId);

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await heartbeat.tickTimers(TICK_AT);
    await waitForHeartbeatIdle();

    // The hard-stop still works — the agent does not run.
    const blockedRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, blockedAgentId));
    expect(blockedRuns).toHaveLength(0);

    // ...and the skip is still recorded for the audit trail.
    const requests = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blockedAgentId));
    expect(requests.some((row) => row.reason === "budget.blocked")).toBe(true);
  }, 30_000);

  it("does not let a budget-blocked agent starve the issue-monitor sweep", async () => {
    const companyId = await seedCompany();
    const blockedAgentId = await seedAgent(companyId, "Budget Blocked Agent");
    await seedExceededBudget(companyId, blockedAgentId);

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    // tickDueIssueMonitors runs after the agent loop, so pre-fix it is
    // unreachable whenever any budget-blocked agent is due. Reaching it at all
    // is the assertion; with no monitors seeded its contribution is zero.
    const result = await heartbeat.tickTimers(TICK_AT);
    expect(result).toMatchObject({ enqueued: 0 });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
