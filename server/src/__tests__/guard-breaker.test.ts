import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  heartbeatRuns,
  budgetPolicies,
  budgetIncidents,
  approvals,
  activityLog,
  instanceSettings,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { runBreakerService } from "../services/run-breaker.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { InstanceGuardsConfig } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const defaultGuards: InstanceGuardsConfig = {
  enabled: true,
  budget: {
    metric: "total_tokens",
    windowKind: "calendar_month_utc",
    companyMonthlyTokens: 40_000_000,
    agentMonthlyTokens: 8_000_000,
    warnPercent: 80,
    hardStop: true,
  },
  perRun: { maxTurnsPerRun: 120, maxTokensPerRun: 1_000_000 },
  breaker: { maxRunsPerAgentPerHour: 15, maxConsecutiveSameIssueRuns: 6 },
};

describeEmbeddedPostgres("platform guard breaker (G4/G5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guard-breaker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      status: "active",
    });
    return { companyId, agentId };
  }

  async function insertRun(
    companyId: string,
    agentId: string,
    opts: { minsAgo: number; issueId?: string } = { minsAgo: 0 }
  ) {
    const createdAt = new Date(Date.now() - opts.minsAgo * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "completed",
      contextSnapshot: opts.issueId ? { issueId: opts.issueId } : {},
      createdAt,
      updatedAt: createdAt,
    });
  }

  // Test 5: >maxRunsPerAgentPerHour runs in 1h → breaker trips, agent paused, incident raised
  it("trips wake_rate breaker when agent exceeds maxRunsPerAgentPerHour", async () => {
    const { companyId, agentId } = await seed();
    const breaker = runBreakerService(db);

    const guards = { ...defaultGuards, breaker: { maxRunsPerAgentPerHour: 3, maxConsecutiveSameIssueRuns: 6 } };

    // Insert 3 recent runs — at threshold, not yet over
    await insertRun(companyId, agentId, { minsAgo: 10 });
    await insertRun(companyId, agentId, { minsAgo: 20 });
    await insertRun(companyId, agentId, { minsAgo: 30 });

    // At threshold (count === 3): should trip (>= 3)
    const trip = await breaker.evaluate(companyId, agentId, null, guards);
    expect(trip).not.toBeNull();
    expect(trip!.reason).toBe("wake_rate");
    expect(trip!.runCount).toBe(3);
    expect(trip!.threshold).toBe(3);

    // Now trip it — agent should be paused + incident opened
    await breaker.trip(companyId, agentId, trip!);

    const updatedAgent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0]!);
    expect(updatedAgent.status).toBe("paused");
    expect(updatedAgent.pauseReason).toBe("budget");

    const incident = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId))
      .then((r) => r[0] ?? null);
    expect(incident).not.toBeNull();
    expect(incident!.status).toBe("open");
    expect(incident!.amountObserved).toBe(3);

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId))
      .then((r) => r[0] ?? null);
    expect(approval).not.toBeNull();
    expect(approval!.type).toBe("budget_override_required");
    expect((approval!.payload as Record<string, unknown>).breakerTripped).toBe(true);
  });

  // Test 5b: old runs (>1h ago) don't count toward wake rate
  it("ignores runs older than 1 hour for wake rate check", async () => {
    const { companyId, agentId } = await seed();
    const breaker = runBreakerService(db);

    const guards = { ...defaultGuards, breaker: { maxRunsPerAgentPerHour: 3, maxConsecutiveSameIssueRuns: 6 } };

    // Insert 2 recent + 5 old runs
    await insertRun(companyId, agentId, { minsAgo: 10 });
    await insertRun(companyId, agentId, { minsAgo: 20 });
    await insertRun(companyId, agentId, { minsAgo: 90 });
    await insertRun(companyId, agentId, { minsAgo: 100 });
    await insertRun(companyId, agentId, { minsAgo: 110 });
    await insertRun(companyId, agentId, { minsAgo: 120 });
    await insertRun(companyId, agentId, { minsAgo: 130 });

    // Only 2 recent — below threshold of 3
    const trip = await breaker.evaluate(companyId, agentId, null, guards);
    expect(trip).toBeNull();
  });

  // Test 6: 6 consecutive same-issue runs → same_issue_loop breaker trips
  it("trips same_issue_loop breaker after maxConsecutiveSameIssueRuns", async () => {
    const { companyId, agentId } = await seed();
    const breaker = runBreakerService(db);
    const issueId = randomUUID();

    const guards = { ...defaultGuards, breaker: { maxRunsPerAgentPerHour: 100, maxConsecutiveSameIssueRuns: 4 } };

    // Insert 4 consecutive runs on same issue (most recent first due to query order)
    await insertRun(companyId, agentId, { minsAgo: 40, issueId });
    await insertRun(companyId, agentId, { minsAgo: 30, issueId });
    await insertRun(companyId, agentId, { minsAgo: 20, issueId });
    await insertRun(companyId, agentId, { minsAgo: 10, issueId });

    const trip = await breaker.evaluate(companyId, agentId, issueId, guards);
    expect(trip).not.toBeNull();
    expect(trip!.reason).toBe("same_issue_loop");
    expect(trip!.runCount).toBe(4);
    expect(trip!.threshold).toBe(4);
  });

  // Test 6b: consecutive loop broken by a different-issue run → no trip
  it("does not trip same_issue_loop when a different issue breaks the consecutive sequence", async () => {
    const { companyId, agentId } = await seed();
    const breaker = runBreakerService(db);
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    const guards = { ...defaultGuards, breaker: { maxRunsPerAgentPerHour: 100, maxConsecutiveSameIssueRuns: 4 } };

    // Oldest-to-newest: issue, otherIssue (breaks chain), issue, issue, issue
    await insertRun(companyId, agentId, { minsAgo: 50, issueId });
    await insertRun(companyId, agentId, { minsAgo: 40, issueId: otherIssueId });
    await insertRun(companyId, agentId, { minsAgo: 30, issueId });
    await insertRun(companyId, agentId, { minsAgo: 20, issueId });
    await insertRun(companyId, agentId, { minsAgo: 10, issueId });

    // Only 3 consecutive at the top — below threshold of 4
    const trip = await breaker.evaluate(companyId, agentId, issueId, guards);
    expect(trip).toBeNull();
  });

  // Test 8 (breaker variant): guards.enabled=false → evaluate always returns null
  it("evaluate returns null when guards disabled", async () => {
    const { companyId, agentId } = await seed();
    const breaker = runBreakerService(db);
    const issueId = randomUUID();

    const disabledGuards: InstanceGuardsConfig = { ...defaultGuards, enabled: false };

    // Saturate with runs — should still return null
    for (let i = 0; i < 20; i++) {
      await insertRun(companyId, agentId, { minsAgo: i * 2, issueId });
    }

    const trip = await breaker.evaluate(companyId, agentId, issueId, disabledGuards);
    expect(trip).toBeNull();
  });
});
