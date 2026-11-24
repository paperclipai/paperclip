import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { activityLog, agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { apiEquivalentByAgent } from "../services/api-equivalent-costs.ts";
import { costService } from "../services/costs.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const MTOK = 1_000_000;

describeEmbeddedPostgres("API-equivalent cost", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-api-equivalent-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Cost Agent", role: "engineer", status: "active",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    return { companyId, agentId };
  }

  async function run(companyId: string, agentId: string, usageJson: Record<string, unknown> | null) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "assignment", status: "succeeded", usageJson });
    return id;
  }

  function event(companyId: string, agentId: string, values: Partial<typeof costEvents.$inferInsert> = {}) {
    return { companyId, agentId, provider: "anthropic", biller: "anthropic", billingType: "subscription_included",
      model: "claude-opus-5-5", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0,
      occurredAt: new Date(), ...values } as typeof costEvents.$inferInsert;
  }

  it("uses the API price the provider reported for a subscription run", async () => {
    const { companyId, agentId } = await seed();
    const heartbeatRunId = await run(companyId, agentId, { costUsd: 1.48 });
    await db.insert(costEvents).values(event(companyId, agentId, { heartbeatRunId, inputTokens: MTOK, outputTokens: MTOK }));
    const value = (await apiEquivalentByAgent(db, companyId)).get(agentId);
    expect(value).toMatchObject({ cents: 148, reportedCents: 148, listPriceCents: 0 });
  });

  it("prices subscription usage without a reported price from the list-price table", async () => {
    const { companyId, agentId } = await seed();
    const heartbeatRunId = await run(companyId, agentId, { costUsd: null });
    await db.insert(costEvents).values(event(companyId, agentId, { heartbeatRunId, inputTokens: MTOK, outputTokens: MTOK }));
    const value = (await apiEquivalentByAgent(db, companyId)).get(agentId);
    expect(value).toMatchObject({ cents: 2400, listPriceCents: 2400, reportedCents: 0 });
  });

  it("adds metered ledger cost to subscription API-equivalent", async () => {
    const { companyId, agentId } = await seed();
    const heartbeatRunId = await run(companyId, agentId, { costUsd: "1.00" });
    await db.insert(costEvents).values([
      event(companyId, agentId, { heartbeatRunId }),
      event(companyId, agentId, { billingType: "metered_api", costCents: 50 }),
    ]);
    expect((await apiEquivalentByAgent(db, companyId)).get(agentId)?.cents).toBeCloseTo(150, 6);
  });

  it("does not count a split run's reported price once per event", async () => {
    const { companyId, agentId } = await seed();
    const heartbeatRunId = await run(companyId, agentId, { costUsd: 3 });
    await db.insert(costEvents).values([
      event(companyId, agentId, { heartbeatRunId, idempotencyKey: "a", inputTokens: MTOK }),
      event(companyId, agentId, { heartbeatRunId, idempotencyKey: "b", model: "claude-haiku-5-5", outputTokens: MTOK }),
    ]);
    const value = (await apiEquivalentByAgent(db, companyId)).get(agentId);
    expect(value?.reportedCents).toBe(0);
    expect(value?.cents).toBeCloseTo(400 + 50, 6);
  });

  it("reports tokens on unknown models as unpriced instead of zero cost", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(costEvents).values(event(companyId, agentId, { model: "mystery-model", inputTokens: 600, outputTokens: 400 }));
    expect((await apiEquivalentByAgent(db, companyId)).get(agentId))
      .toMatchObject({ cents: 0, unpricedTokens: 1000, unpricedModels: ["mystery-model"] });
  });

  it("adds the figure to byAgent rows and the summary total", async () => {
    const { companyId, agentId } = await seed();
    const heartbeatRunId = await run(companyId, agentId, { costUsd: 2.5 });
    await db.insert(costEvents).values(event(companyId, agentId, { heartbeatRunId }));
    const costs = costService(db);
    const [row] = await costs.byAgent(companyId);
    expect(row.apiEquivalent?.cents).toBe(250);
    expect(row.costCents).toBe(0);
    const summary = await costs.summary(companyId);
    expect(summary.apiEquivalent?.cents).toBe(250);
    expect(summary.spendCents).toBe(0);
  });
});
