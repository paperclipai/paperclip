import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingRuntimeBaselines, agents, agentRuntimeState, companies, costEvents, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { ensureRuntimeAccountingBaseline, readRuntimeAccountingTotals } from "./runtime-accounting-totals.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("ledger-derived runtime totals", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-ledger-totals-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runtime totals", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runtime totals", adapterType: "process" });
    await db.insert(agentRuntimeState).values({ agentId, companyId, adapterType: "process",
      totalCostCents: 125.125, totalInputTokens: 100, totalCachedInputTokens: 20, totalOutputTokens: 30 });
    return { companyId, agentId };
  }

  it("preserves the legacy baseline exactly and includes acknowledged ledger/valuation changes once", async () => {
    const owner = await seed();
    await db.transaction(tx => ensureRuntimeAccountingBaseline(tx as unknown as Db, owner.companyId, owner.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ ...owner, status: "succeeded", costAccountedAt: new Date(), accountingProjectionVersion: "v2" }).returning();
    const [event] = await db.insert(costEvents).values({ ...owner, heartbeatRunId: run.id, provider: "test", model: "test",
      costCents: 1.125, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, occurredAt: new Date("2020-01-01Z") }).returning();
    const [pending] = await db.insert(heartbeatRuns).values({ ...owner, status: "succeeded", costAccountingPending: true, accountingProjectionVersion: "v2" }).returning();
    await db.insert(costEvents).values({ ...owner, heartbeatRunId: pending.id, provider: "test", model: "test",
      costCents: 99, inputTokens: 999, occurredAt: new Date() });
    expect(await readRuntimeAccountingTotals(db, owner.companyId, owner.agentId)).toEqual({
      totalCostCents: 126.25, totalInputTokens: 110, totalCachedInputTokens: 22, totalOutputTokens: 33,
    });
    // Effective valuation can be corrected without mutating an agent counter.
    await db.update(costEvents).set({ costCents: 2.125 }).where(eq(costEvents.id, event.id));
    expect((await readRuntimeAccountingTotals(db, owner.companyId, owner.agentId)).totalCostCents).toBe(127.25);
    const [raw] = await db.select({ cents: sql<string>`${agentRuntimeState.totalCostCents}::text` }).from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, owner.agentId));
    expect(raw.cents).toBe("125.1250000");
    expect(await db.select().from(accountingRuntimeBaselines).where(eq(accountingRuntimeBaselines.agentId, owner.agentId))).toHaveLength(1);
  });

  it("does not double-count a historical acknowledged ledger when its baseline is missing", async () => {
    const owner = await seed();
    await db.insert(heartbeatRuns).values({ ...owner, status: "succeeded", costAccountedAt: new Date(), accountingProjectionVersion: "v2" });
    expect((await readRuntimeAccountingTotals(db, owner.companyId, owner.agentId)).totalCostCents).toBe(125.125);
    await expect(db.transaction(tx => ensureRuntimeAccountingBaseline(tx as unknown as Db, owner.companyId, owner.agentId)))
      .rejects.toThrow("baseline is missing");
    expect(await db.select().from(accountingRuntimeBaselines).where(eq(accountingRuntimeBaselines.agentId, owner.agentId))).toEqual([]);
  });
});
