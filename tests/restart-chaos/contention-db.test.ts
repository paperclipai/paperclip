/**
 * Harness-level check that `--db-pressure` reproduces the #20385 race against
 * real PostgreSQL: under the pressure writers, a usage receipt written with the
 * pre-#20385 repeatable-read transaction exhausts its retries with 40001,
 * while the current READ COMMITTED writer (`persistUsageReceipt`) commits.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../server/src/__tests__/helpers/embedded-postgres.js";
import { withOperationAccountingTransaction } from "../../server/src/services/accounting-transaction.js";
import { persistUsageReceipt, persistUsageReceiptInTransaction, type UsageReceiptEnvelope } from "../../server/src/services/usage-receipts.js";
import { RunRowPressure } from "./contention.js";

const support = await getEmbeddedPostgresTestSupport();
const RECEIPTS = 8;

describe.skipIf(!support.supported)("--db-pressure against real PostgreSQL (#20385)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("restart-chaos-contention-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function runningRun() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Contention fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Contention agent", adapterType: "process", status: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    const receipt = (sequence: number): UsageReceiptEnvelope => ({ schema: "paperclip/accounting-receipt/v1",
      id: randomUUID(), companyId, runId, sourceId, sequence, receivedAt: new Date().toISOString(), adapterType: "process",
      receipt: { complete: false, usageBasis: "per_run", costUsd: sequence / 100, billingType: "metered_api" } });
    return { companyId, runId, receipt };
  }

  async function underPressure<T>(companyId: string, work: () => Promise<T>) {
    const pressure = new RunRowPressure(database.connectionString, companyId, 4).start();
    // Let the writers reach steady state.
    while (pressure.stats.rowsTouched < 50) await new Promise(resolve => setTimeout(resolve, 10));
    try { return await work(); } finally {
      const stats = await pressure.stop();
      expect(stats.errors).toBe(0);
    }
  }

  it("makes the pre-#20385 repeatable-read receipt writer exhaust its retries with 40001", async () => {
    const f = await runningRun();
    const outcomes = await underPressure(f.companyId, async () => {
      const results: string[] = [];
      for (let sequence = 1; sequence <= RECEIPTS; sequence += 1) {
        // The pre-#20385 persistUsageReceipt: the same work in the default repeatable-read transaction.
        results.push(await withOperationAccountingTransaction(db, f.companyId, tx => persistUsageReceiptInTransaction(tx, f.receipt(sequence)))
          .then(() => "committed", (error: { code?: string; cause?: { code?: string } }) => error.code ?? error.cause?.code ?? "error"));
      }
      return results;
    });
    // Locally every one exhausts (8/8); at least half leaves room for a slow CI host.
    expect(outcomes.filter(outcome => outcome === "40001").length).toBeGreaterThanOrEqual(RECEIPTS / 2);
  }, 60_000);

  it("commits every receipt with the current READ COMMITTED writer", async () => {
    const f = await runningRun();
    await underPressure(f.companyId, async () => {
      for (let sequence = 1; sequence <= RECEIPTS; sequence += 1) await persistUsageReceipt(db, f.receipt(sequence));
    });
    const [row] = await db.$client.unsafe("select count(*)::int as n from run_usage_receipts where run_id = $1", [f.runId]) as Array<{ n: number }>;
    expect(row?.n).toBe(RECEIPTS);
  }, 60_000);
});
