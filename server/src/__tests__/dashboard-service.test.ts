import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      recovered: 0,
      other: 0,
      total: 105,
      failedByErrorCode: {},
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      recovered: 0,
      other: 1,
      total: 3,
      // failed + timed_out with no error code both bucket under "unknown"
      failedByErrorCode: { unknown: 2 },
    });
  });

  it("separates recovered restart kills from true failures and breaks failures down by error code", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const day = utcDay(-2);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const base = {
      companyId,
      agentId,
      invocationSource: "assignment",
      createdAt: day,
    };

    // Direct recovery: a process-loss kill whose retry succeeded.
    const original = randomUUID();
    const retry = randomUUID();
    // Chained recovery: kill -> failed retry -> succeeded retry (both kills recovered).
    const chainedOriginal = randomUUID();
    const chainedRetry = randomUUID();
    const chainedRetrySuccess = randomUUID();
    // A genuine, unrecovered failure that should remain in the failed count.
    const trueFailure = randomUUID();

    await db.insert(heartbeatRuns).values([
      { ...base, id: original, status: "failed", errorCode: "process_lost" },
      { ...base, id: retry, status: "succeeded", retryOfRunId: original },
      { ...base, id: chainedOriginal, status: "failed", errorCode: "process_lost" },
      { ...base, id: chainedRetry, status: "failed", errorCode: "process_lost", retryOfRunId: chainedOriginal },
      { ...base, id: chainedRetrySuccess, status: "succeeded", retryOfRunId: chainedRetry },
      { ...base, id: trueFailure, status: "failed", errorCode: "provider_quota" },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    const bucket = summary.runActivity.find((b) => b.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 2,
      // original + chainedOriginal + chainedRetry all recovered via a later success
      recovered: 3,
      failed: 1,
      other: 0,
      total: 6,
      failedByErrorCode: { provider_quota: 1 },
    });
    // process_lost kills that recovered must not leak into the failed breakdown.
    expect(bucket?.failedByErrorCode.process_lost).toBeUndefined();
  });

  async function seedCompanyWithAgent() {
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
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function costEvent(input: {
    companyId: string;
    agentId: string;
    billingType: string;
    costCents?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    occurredAt?: Date;
  }) {
    return {
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: input.billingType,
      model: "claude-sonnet-4-6",
      inputTokens: input.inputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      costCents: input.costCents ?? 0,
      occurredAt: input.occurredAt ?? new Date(),
    };
  }

  it("reports token usage for subscription-billed runs whose cost is always zero", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();

    // `normalizeBilledCostCents` forces costCents to 0 for subscription runs, so
    // spend alone cannot describe this company. Tokens carry the whole signal.
    await db.insert(costEvents).values([
      costEvent({ companyId, agentId, billingType: "subscription_included", inputTokens: 1_000, cachedInputTokens: 20_000, outputTokens: 300 }),
      costEvent({ companyId, agentId, billingType: "subscription_included", inputTokens: 500, cachedInputTokens: 5_000, outputTokens: 100 }),
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.costs).toMatchObject({
      monthSpendCents: 0,
      monthInputTokens: 1_500,
      monthCachedInputTokens: 25_000,
      monthOutputTokens: 400,
      monthBillingIsSubscriptionOnly: true,
    });
  });

  it("does not claim subscription-only billing when any run is metered", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();

    await db.insert(costEvents).values([
      costEvent({ companyId, agentId, billingType: "subscription_included", inputTokens: 1_000 }),
      costEvent({ companyId, agentId, billingType: "metered_api", inputTokens: 200, costCents: 75 }),
    ]);

    const summary = await dashboardService(db).summary(companyId);

    // A single metered run means a dollar figure is meaningful again, so the UI
    // must keep showing spend rather than swapping to token usage.
    expect(summary.costs.monthBillingIsSubscriptionOnly).toBe(false);
    expect(summary.costs.monthSpendCents).toBe(75);
    expect(summary.costs.monthInputTokens).toBe(1_200);
  });

  it("treats a period with no metered runs as not subscription-only", async () => {
    const { companyId } = await seedCompanyWithAgent();

    const summary = await dashboardService(db).summary(companyId);

    // Vacuous truth would suppress the spend tile on a dollar-billed deployment
    // that simply had a quiet month.
    expect(summary.costs.monthBillingIsSubscriptionOnly).toBe(false);
    expect(summary.costs.monthInputTokens).toBe(0);
  });

  it("scopes token totals to the company and the current UTC month", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const other = await seedCompanyWithAgent();
    const lastMonth = new Date(getUtcMonthStart(new Date()).getTime() - 24 * 60 * 60 * 1000);

    await db.insert(costEvents).values([
      costEvent({ companyId, agentId, billingType: "subscription_included", inputTokens: 1_000 }),
      costEvent({ companyId, agentId, billingType: "subscription_included", inputTokens: 999, occurredAt: lastMonth }),
      costEvent({ companyId: other.companyId, agentId: other.agentId, billingType: "subscription_included", inputTokens: 777 }),
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.costs.monthInputTokens).toBe(1_000);
  });
});
