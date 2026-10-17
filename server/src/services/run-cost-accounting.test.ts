import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { RECEIPT_WAIT_MS } from "./cost-data-quality.js";
import { accountRunCost, reconcileRunCosts } from "./run-cost-accounting.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping run cost accounting database tests: ${support.reason}`);
describe.skipIf(!support.supported)("cancelled run cost accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-cost-accounting");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  const partialUsage = {
    accountingReceiptReady: false, provider: "openrouter", biller: "openrouter", model: "z-ai/glm-5.3",
    billingType: "metered_api", inputTokens: 1000, cachedInputTokens: 50000, outputTokens: 200, costUsd: 0.25,
  };

  async function cancelledRun(finishedAgoMs: number, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Cost accounting", issuePrefix: "CA" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Cost agent", adapterType: "opencode_local" }).returning();
    const finishedAt = new Date(Date.now() - finishedAgoMs);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "cancelled", costAccountingPending: true,
      createdAt: finishedAt, finishedAt, updatedAt: finishedAt, usageJson: partialUsage, ...patch,
    }).returning();
    return run;
  }

  const eventsFor = (runId: string) => db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));

  it("keeps a fresh cancellation pending so a late receipt can still settle it", async () => {
    const run = await cancelledRun(60_000);
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect(await eventsFor(run.id)).toHaveLength(0);
  });

  it("books a cancellation's partial usage as an estimate after the receipt window", async () => {
    const run = await cancelledRun(RECEIPT_WAIT_MS + 60_000);
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    const [event] = await eventsFor(run.id);
    expect(event).toMatchObject({ costStatus: "estimated", costCents: 25, inputTokens: 1000, cachedInputTokens: 50000, outputTokens: 200 });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.costAccountingPending).toBe(false);
  });

  it("does not invent spend for an old cancellation without usage", async () => {
    const run = await cancelledRun(RECEIPT_WAIT_MS + 60_000, { usageJson: { accountingReceiptReady: false } });
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect(await eventsFor(run.id)).toHaveLength(0);
  });

  it("still waits on an incomplete receipt for runs that ended on their own", async () => {
    const run = await cancelledRun(RECEIPT_WAIT_MS + 60_000, { status: "failed" });
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect(await eventsFor(run.id)).toHaveLength(0);
  });
});
