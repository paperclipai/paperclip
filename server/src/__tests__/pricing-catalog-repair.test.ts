import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { PRICING_CATALOG_VERSION, repairHistoricalPricing } from "../services/pricing-catalog.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pricing repair tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("repairHistoricalPricing", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("pricing-catalog-repair");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  async function seedEvent(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof costEvents.$inferInsert>,
  ) {
    const id = randomUUID();
    await db.insert(costEvents).values({
      id,
      companyId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "api",
      costStatus: "unpriced",
      pricingCatalogVersion: null,
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      costCents: 0,
      occurredAt: new Date(),
      createdAt: new Date(),
      ...overrides,
    });
    return id;
  }

  it("leaves a reported zero alone, because a sub-cent charge rounds to zero", async () => {
    const { companyId, agentId } = await seedCompany();
    // resolveLedgerCostStatus writes `reported` when the provider named a cost,
    // so a reported zero is a charge that rounded down, not an absent price.
    const id = await seedEvent(companyId, agentId, { costStatus: "reported", costCents: 0 });

    const result = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(result).toMatchObject({ scanned: 0, confidentlyMatched: 0, updatedEventIds: [] });

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.costCents).toBe(0);
    expect(row.costStatus).toBe("reported");
    expect(row.pricingCatalogVersion).toBeNull();
  });

  it("repairs a row that was never priced, has no cost, and names no catalog version", async () => {
    const { companyId, agentId } = await seedCompany();
    const id = await seedEvent(companyId, agentId, {});

    const dryRun = await repairHistoricalPricing(db, { companyId, apply: false });
    expect(dryRun).toMatchObject({ dryRun: true, scanned: 1, confidentlyMatched: 1, updatedEventIds: [] });

    const applied = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(applied).toMatchObject({ dryRun: false, scanned: 1, confidentlyMatched: 1 });
    expect(applied.updatedEventIds).toEqual([id]);

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.costCents).toBe(1250);
    expect(row.costStatus).toBe("reported");
    expect(row.pricingCatalogVersion).toBe(PRICING_CATALOG_VERSION);
  });

  it("leaves a cost the provider reported alone", async () => {
    const { companyId, agentId } = await seedCompany();
    const id = await seedEvent(companyId, agentId, { costCents: 777 });

    const result = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(result).toMatchObject({ scanned: 0, confidentlyMatched: 0, updatedEventIds: [] });

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.costCents).toBe(777);
    expect(row.pricingCatalogVersion).toBeNull();
  });

  it("leaves an included subscription event at its contractual zero", async () => {
    const { companyId, agentId } = await seedCompany();
    const id = await seedEvent(companyId, agentId, { billingType: "subscription_included", costCents: 0 });

    const result = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(result).toMatchObject({ scanned: 0, confidentlyMatched: 0, updatedEventIds: [] });

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.costCents).toBe(0);
    expect(row.pricingCatalogVersion).toBeNull();
  });

  it("does not re-price a row that already names a catalog version", async () => {
    const { companyId, agentId } = await seedCompany();
    const id = await seedEvent(companyId, agentId, {
      costCents: 0,
      pricingCatalogVersion: "2020-01-01.v0",
    });

    const result = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(result).toMatchObject({ scanned: 0, confidentlyMatched: 0, updatedEventIds: [] });

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.pricingCatalogVersion).toBe("2020-01-01.v0");
    expect(row.costCents).toBe(0);
  });

  it("scans a repairable row the catalog cannot price, and does not write it", async () => {
    const { companyId, agentId } = await seedCompany();
    const id = await seedEvent(companyId, agentId, { provider: "mystery", biller: "mystery", model: "mystery-1" });

    const result = await repairHistoricalPricing(db, { companyId, apply: true });
    expect(result).toMatchObject({ scanned: 1, confidentlyMatched: 0, updatedEventIds: [] });

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, id));
    expect(row.costCents).toBe(0);
    expect(row.pricingCatalogVersion).toBeNull();
  });
});
