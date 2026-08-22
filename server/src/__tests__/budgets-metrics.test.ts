import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import { costService } from "../services/costs.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budget service token_count / run_count metrics", () => {
  let db!: ReturnType<typeof createDb>;
  let budgets!: ReturnType<typeof budgetService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-metrics-");
    db = createDb(tempDb.connectionString);
    budgets = budgetService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompanyAndAgent(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function getAgentRow(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row;
  }

  it("reports zero observed amount for a token_count policy with no cost events", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Empty Window Agent");
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "token_count",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const overview = await budgets.overview(companyId);
    const summary = overview.policies.find((policy) => policy.scopeId === agentId);
    expect(summary?.observedAmount).toBe(0);
    expect(summary?.status).toBe("ok");
  });

  it("trips a token_count hard-stop and pauses the agent, mirroring billed_cents behavior", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Token Budget Agent");
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "token_count",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const costs = costService(db, { cancelWorkForScope: async () => {} });
    // Subscription-billed usage: cost_cents is 0, only tokens are metered.
    await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-opus",
      inputTokens: 600,
      cachedInputTokens: 0,
      outputTokens: 500,
      costCents: 0,
      occurredAt: new Date(),
    });

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.status).toBe("paused");
    expect(agentRow?.pauseReason).toBe("budget");

    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId));
    expect(incident?.thresholdType).toBe("hard");
    expect(incident?.metric).toBe("token_count");
    expect(incident?.amountObserved).toBe(1100);
  });

  it("does not trip a token_count budget while usage stays under the threshold", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Under Threshold Agent");
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "token_count",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const costs = costService(db, { cancelWorkForScope: async () => {} });
    await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-opus",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 100,
      costCents: 0,
      occurredAt: new Date(),
    });

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.status).not.toBe("paused");
  });

  it("counts run_count by distinct heartbeat_run_id, not by cost_events row count", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Run Budget Agent");
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "run_count",
      windowKind: "calendar_month_utc",
      amount: 2,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const runOneId = randomUUID();
    const runTwoId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runOneId, companyId, agentId },
      { id: runTwoId, companyId, agentId },
    ]);

    const costs = costService(db, { cancelWorkForScope: async () => {} });

    // Same run emits two cost_events rows (e.g. two different models in one run).
    await costs.createEvent(companyId, {
      heartbeatRunId: runOneId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 10,
      costCents: 0,
      occurredAt: new Date(),
    });
    await costs.createEvent(companyId, {
      heartbeatRunId: runOneId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5-mini",
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 5,
      costCents: 0,
      occurredAt: new Date(),
    });

    // Still only one distinct run so far -- must not have paused.
    expect((await getAgentRow(agentId))?.status).not.toBe("paused");

    // A second, distinct run reaches the run_count threshold of 2.
    await costs.createEvent(companyId, {
      heartbeatRunId: runTwoId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents: 0,
      occurredAt: new Date(),
    });

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.status).toBe("paused");
    expect(agentRow?.pauseReason).toBe("budget");

    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId));
    expect(incident?.metric).toBe("run_count");
    expect(incident?.amountObserved).toBe(2);
  });

  it("scopes a token_count policy to its own agent and ignores other agents' usage", async () => {
    const { companyId, agentId: agentAId } = await createCompanyAndAgent("Scoped Agent A");
    const agentB = randomUUID();
    await db.insert(agents).values({
      id: agentB,
      companyId,
      name: "Scoped Agent B",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentAId,
      metric: "token_count",
      windowKind: "calendar_month_utc",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const costs = costService(db, { cancelWorkForScope: async () => {} });
    // Agent B blows well past what would be A's threshold, but A has no policy tie to it.
    await costs.createEvent(companyId, {
      agentId: agentB,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5",
      inputTokens: 5000,
      cachedInputTokens: 0,
      outputTokens: 5000,
      costCents: 0,
      occurredAt: new Date(),
    });

    expect((await getAgentRow(agentAId))?.status).not.toBe("paused");

    const overview = await budgets.overview(companyId);
    const summaryA = overview.policies.find((policy) => policy.scopeId === agentAId);
    expect(summaryA?.observedAmount).toBe(0);
  });

  it("leaves billed_cents policies unaffected by the widened metric handling (regression)", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Billed Cents Agent");
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 500,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    const costs = costService(db, { cancelWorkForScope: async () => {} });
    await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 100,
      costCents: 600,
      occurredAt: new Date(),
    });

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.status).toBe("paused");
    expect(agentRow?.pauseReason).toBe("budget");

    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId));
    expect(incident?.metric).toBe("billed_cents");
    expect(incident?.amountObserved).toBe(600);
  });

  it("does not resume a scope when raising one exceeded metric while another metric is still over its hard stop", async () => {
    const { companyId, agentId } = await createCompanyAndAgent("Cross Metric Agent");
    await db.insert(budgetPolicies).values([
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "token_count",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      },
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "run_count",
        windowKind: "calendar_month_utc",
        amount: 1,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      },
    ]);

    const costs = costService(db, { cancelWorkForScope: async () => {} });
    // One run, well over both the token_count and run_count thresholds -- both
    // policies hard-stop and pause the agent.
    await costs.createEvent(companyId, {
      heartbeatRunId: (await db.insert(heartbeatRuns).values({ companyId, agentId }).returning())[0]!.id,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 100,
      costCents: 0,
      occurredAt: new Date(),
    });

    expect((await getAgentRow(agentId))?.status).toBe("paused");

    // Raising only the token_count budget must not resume the agent: run_count
    // is still over its own hard-stop threshold.
    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "token_count",
        amount: 100_000,
        windowKind: "calendar_month_utc",
      },
      "test-board-user",
    );

    expect((await getAgentRow(agentId))?.status).toBe("paused");

    // Now raise run_count too -- with no policy left exceeded, the agent resumes.
    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "run_count",
        amount: 100,
        windowKind: "calendar_month_utc",
      },
      "test-board-user",
    );

    const agentRow = await getAgentRow(agentId);
    expect(agentRow?.status).not.toBe("paused");
    expect(agentRow?.pauseReason).toBeNull();
  });
});
