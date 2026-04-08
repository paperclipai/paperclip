import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  calculateShadowCostForCandidate,
  shadowCostBackfillService,
} from "../services/shadow-cost-backfill.js";

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shadow backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("calculateShadowCostForCandidate", () => {
  it("uses the OpenAI gpt-5.4 shadow rate card", () => {
    const result = calculateShadowCostForCandidate({
      id: "cost-1",
      companyId: "company-1",
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      model: "gpt-5.4",
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 100_000,
      costCents: 0,
      currentShadowCostCents: 0,
      heartbeatRunId: "run-1",
      occurredAt: new Date("2026-04-06T00:00:00.000Z"),
      usageJson: null,
    });

    expect(result).toEqual({
      proposedShadowCostCents: 675,
      source: "openai_rate_card",
      reason: null,
    });
  });

  it("uses heartbeat usage cost aliases for Anthropic subscription runs", () => {
    const result = calculateShadowCostForCandidate({
      id: "cost-2",
      companyId: "company-1",
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-opus-4-6",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      currentShadowCostCents: 0,
      heartbeatRunId: "run-2",
      occurredAt: new Date("2026-04-06T00:00:00.000Z"),
      usageJson: { cost_usd: 0.40245075 },
    });

    expect(result).toEqual({
      proposedShadowCostCents: 40,
      source: "heartbeat_usage_cost",
      reason: null,
    });
  });
});

describeEmbeddedPostgres("shadowCostBackfillService", () => {
  let db!: ClosableDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shadow-cost-backfill-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    await tempDb?.cleanup();
  });

  it("plans and applies shadow-only updates without changing billed spend", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const openAiRunId = randomUUID();
    const anthropicRunId = randomUUID();
    const openAiCostId = randomUUID();
    const anthropicCostId = randomUUID();
    const existingShadowCostId = randomUUID();
    const meteredCostId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Backfill Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: openAiRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "assignment",
        usageJson: { provider: "openai" },
      },
      {
        id: anthropicRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "assignment",
        usageJson: { costUsd: 0.3851785 },
      },
    ]);

    await db.insert(costEvents).values([
      {
        id: openAiCostId,
        companyId,
        agentId,
        heartbeatRunId: openAiRunId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 2_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 100_000,
        costCents: 0,
        shadowCostCents: 0,
        occurredAt: new Date("2026-04-06T00:00:00.000Z"),
      },
      {
        id: anthropicCostId,
        companyId,
        agentId,
        heartbeatRunId: anthropicRunId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-opus-4-6",
        inputTokens: 18,
        cachedInputTokens: 517_441,
        outputTokens: 2_972,
        costCents: 0,
        shadowCostCents: 0,
        occurredAt: new Date("2026-04-06T00:05:00.000Z"),
      },
      {
        id: existingShadowCostId,
        companyId,
        agentId,
        heartbeatRunId: openAiRunId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        shadowCostCents: 25,
        occurredAt: new Date("2026-04-06T00:10:00.000Z"),
      },
      {
        id: meteredCostId,
        companyId,
        agentId,
        heartbeatRunId: openAiRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5.4-codex",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 200,
        costCents: 10,
        shadowCostCents: 0,
        occurredAt: new Date("2026-04-06T00:15:00.000Z"),
      },
    ]);

    const service = shadowCostBackfillService(db);
    const plan = await service.plan({ companyId });

    expect(plan.columnPresent).toBe(true);
    expect(plan.summary.matchedRowCount).toBe(3);
    expect(plan.summary.updateRowCount).toBe(2);
    expect(plan.summary.totalDeltaShadowCostCents).toBe(714);

    const openAiPlan = plan.rows.find((row) => row.id === openAiCostId);
    const anthropicPlan = plan.rows.find((row) => row.id === anthropicCostId);
    const existingPlan = plan.rows.find((row) => row.id === existingShadowCostId);

    expect(openAiPlan).toMatchObject({
      action: "update",
      proposedShadowCostCents: 675,
      deltaShadowCostCents: 675,
      source: "openai_rate_card",
    });
    expect(anthropicPlan).toMatchObject({
      action: "update",
      proposedShadowCostCents: 39,
      deltaShadowCostCents: 39,
      source: "heartbeat_usage_cost",
    });
    expect(existingPlan).toMatchObject({
      action: "skip",
      currentShadowCostCents: 25,
      proposedShadowCostCents: 250,
      reason: "existing_shadow_cost",
    });

    const applyResult = await service.apply(plan);
    expect(applyResult).toEqual({
      updatedCount: 2,
      totalShadowCostCents: 714,
      totalDeltaShadowCostCents: 714,
    });

    const updatedRows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    const updatedOpenAi = updatedRows.find((row) => row.id === openAiCostId);
    const updatedAnthropic = updatedRows.find((row) => row.id === anthropicCostId);
    const updatedExisting = updatedRows.find((row) => row.id === existingShadowCostId);
    const updatedMetered = updatedRows.find((row) => row.id === meteredCostId);

    expect(updatedOpenAi?.costCents).toBe(0);
    expect(updatedOpenAi?.shadowCostCents).toBe(675);
    expect(updatedAnthropic?.costCents).toBe(0);
    expect(updatedAnthropic?.shadowCostCents).toBe(39);
    expect(updatedExisting?.costCents).toBe(0);
    expect(updatedExisting?.shadowCostCents).toBe(25);
    expect(updatedMetered?.costCents).toBe(10);
    expect(updatedMetered?.shadowCostCents).toBe(0);
  });
});
