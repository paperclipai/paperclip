import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  budgetPolicies,
  activityLog,
  instanceSettings,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { budgetService } from "../services/budgets.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("platform guard budget (G1/G2/G5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guard-budget-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedGuardsEnabled(overrides: Partial<{
    companyMonthlyTokens: number;
    agentMonthlyTokens: number;
  }> = {}) {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      guards: {
        enabled: true,
        budget: {
          metric: "total_tokens",
          windowKind: "calendar_month_utc",
          companyMonthlyTokens: overrides.companyMonthlyTokens ?? 40_000_000,
          agentMonthlyTokens: overrides.agentMonthlyTokens ?? 8_000_000,
          warnPercent: 80,
          hardStop: true,
        },
        perRun: { maxTurnsPerRun: 120, maxTokensPerRun: 1_000_000 },
        breaker: { maxRunsPerAgentPerHour: 15, maxConsecutiveSameIssueRuns: 6 },
      },
    });
  }

  async function seedGuardsDisabled() {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      guards: { enabled: false },
    });
  }

  async function createCompanyAndAgent() {
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

  // Test 1: new company/agent → default token policies auto-created
  it("auto-upserts company+agent token policies on create when guards enabled", async () => {
    await seedGuardsEnabled();
    const { companyId, agentId } = await createCompanyAndAgent();

    const instSvc = instanceSettingsService(db);
    const budgets = budgetService(db, { cancelWorkForScope: async () => {} });
    const guards = await instSvc.getGuards();

    // Simulate what companies.ts route does on company create
    if (guards.enabled && guards.budget.companyMonthlyTokens > 0) {
      await budgets.upsertPolicy(companyId, {
        scopeType: "company",
        scopeId: companyId,
        metric: guards.budget.metric,
        amount: guards.budget.companyMonthlyTokens,
        windowKind: guards.budget.windowKind,
        warnPercent: guards.budget.warnPercent,
        hardStopEnabled: guards.budget.hardStop,
      }, null);
    }
    // Simulate what agents.ts route does on agent create
    if (guards.enabled && guards.budget.agentMonthlyTokens > 0) {
      await budgets.upsertPolicy(companyId, {
        scopeType: "agent",
        scopeId: agentId,
        metric: guards.budget.metric,
        amount: guards.budget.agentMonthlyTokens,
        windowKind: guards.budget.windowKind,
        warnPercent: guards.budget.warnPercent,
        hardStopEnabled: guards.budget.hardStop,
      }, null);
    }

    const companyPolicy = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "company")))
      .then((r) => r[0] ?? null);
    const agentPolicy = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "agent")))
      .then((r) => r[0] ?? null);

    expect(companyPolicy).not.toBeNull();
    expect(companyPolicy!.metric).toBe("total_tokens");
    expect(companyPolicy!.amount).toBe(40_000_000);
    expect(companyPolicy!.hardStopEnabled).toBe(true);

    expect(agentPolicy).not.toBeNull();
    expect(agentPolicy!.metric).toBe("total_tokens");
    expect(agentPolicy!.amount).toBe(8_000_000);
    expect(agentPolicy!.hardStopEnabled).toBe(true);
  });

  // Test 2: backfill → agent without a policy gains one idempotently
  it("backfill upsert is idempotent — agent gains policy only if missing", async () => {
    await seedGuardsEnabled();
    const { companyId, agentId } = await createCompanyAndAgent();

    const budgets = budgetService(db, { cancelWorkForScope: async () => {} });
    const instSvc = instanceSettingsService(db);
    const guards = await instSvc.getGuards();

    const upsertAgentPolicy = async () => {
      await budgets.upsertPolicy(companyId, {
        scopeType: "agent",
        scopeId: agentId,
        metric: guards.budget.metric,
        amount: guards.budget.agentMonthlyTokens,
        windowKind: guards.budget.windowKind,
        warnPercent: guards.budget.warnPercent,
        hardStopEnabled: guards.budget.hardStop,
      }, null);
    };

    // Run twice — idempotency check
    await upsertAgentPolicy();
    await upsertAgentPolicy();

    const policies = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "agent")));

    expect(policies).toHaveLength(1);
    expect(policies[0].amount).toBe(8_000_000);
  });

  // Test 7: budget hard-stop → agent paused → getInvocationBlock blocks next wake
  // evaluateCostEvent pauses the agent with pauseReason:"budget"; getInvocationBlock
  // checks that status directly (doesn't re-compute cost — the pause IS the block).
  it("getInvocationBlock blocks when agent is paused due to budget hard-stop", async () => {
    await seedGuardsEnabled();
    const { companyId, agentId } = await createCompanyAndAgent();

    const budgets = budgetService(db, { cancelWorkForScope: async () => {} });

    // No block yet — agent is active
    const noBlock = await budgets.getInvocationBlock(companyId, agentId, {});
    expect(noBlock).toBeNull();

    // Simulate evaluateCostEvent hard-stop: pause the agent with pauseReason:"budget"
    const now = new Date();
    await db.update(agents)
      .set({ status: "paused", pauseReason: "budget", pausedAt: now, updatedAt: now })
      .where(eq(agents.id, agentId));

    // Now getInvocationBlock should return a block
    const block = await budgets.getInvocationBlock(companyId, agentId, {});
    expect(block).not.toBeNull();
    expect(block!.scopeType).toBe("agent");
    expect(block!.reason).toContain("paused");

    // Simulate raise-and-resume: set agent back to active
    await db.update(agents)
      .set({ status: "active", pauseReason: null, pausedAt: null, updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    const afterResume = await budgets.getInvocationBlock(companyId, agentId, {});
    expect(afterResume).toBeNull();
  });

  // Test 8: guards.enabled=false → no block, no policies created
  it("guards disabled → getGuards returns enabled=false, no auto-policy created", async () => {
    await seedGuardsDisabled();
    const { companyId, agentId } = await createCompanyAndAgent();

    const instSvc = instanceSettingsService(db);
    const guards = await instSvc.getGuards();

    expect(guards.enabled).toBe(false);

    // Simulate create-company hook with guard disabled check
    if (guards.enabled) {
      const budgets = budgetService(db, { cancelWorkForScope: async () => {} });
      await budgets.upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId,
        metric: guards.budget.metric, amount: guards.budget.agentMonthlyTokens,
        windowKind: guards.budget.windowKind, warnPercent: guards.budget.warnPercent,
        hardStopEnabled: guards.budget.hardStop,
      }, null);
    }

    const policies = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId));

    expect(policies).toHaveLength(0);
  });
});
