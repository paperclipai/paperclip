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
import { collectContentionEvidence, RunRowPressure } from "./contention.js";

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

  it("reads a task's accounting evidence from the wave database", async () => {
    const f = await runningRun();
    const sourceId = randomUUID();
    const journal = (sequence: number, sourceEventId: string, eventType: string) => db.$client.unsafe(
      `insert into run_usage_receipts (id, company_id, run_id, source_id, sequence, receipt_hash, receipt_json, complete, received_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, false, now())`,
      [randomUUID(), f.companyId, f.runId, sourceId, sequence, `hash-${sequence}`,
        JSON.stringify({ producerEvent: { sourceEventId, eventType } })]);
    await journal(1, "evt-1", "turn.started");
    await journal(2, "evt-2", "usage.reported");
    // The same producer event journaled twice for one source: the oracle's exactly-once check must see it.
    await journal(3, "evt-2", "usage.reported");
    await journal(4, "evt-3", "turn.completed");
    await db.$client.unsafe(
      `update heartbeat_runs set status = 'succeeded', error_code = null, log_bytes = 4096, cost_accounted_at = now(),
         usage_json = usage_json || '{"accountingReceiptOwner":"native_producer","costUsd":0.25}'::jsonb where id = $1`, [f.runId]);
    // Agent cost events name their agent; `agentOf` is the run whose agent is charged.
    const cost = (companyId: string, runId: string | null, agentOf: string, cents: number) => db.$client.unsafe(
      `insert into cost_events (company_id, agent_id, heartbeat_run_id, provider, model, cost_cents, occurred_at)
       values ($1, (select agent_id from heartbeat_runs where id = $3), $2, 'openai', 'test-model', $4, now())`,
      [companyId, runId, agentOf, cents]);
    await cost(f.companyId, f.runId, f.runId, 10);
    await cost(f.companyId, f.runId, f.runId, 15);
    // A cost of the same company outside this run counts toward the company total only.
    await cost(f.companyId, null, f.runId, 5);
    // Another company's cost counts toward neither.
    const elsewhere = await runningRun();
    await cost(elsewhere.companyId, elsewhere.runId, elsewhere.runId, 1000);
    const evidence = await collectContentionEvidence(db, f.companyId, [f.runId], { spendCents: 30, pendingRunCount: 0 });
    expect(evidence.error).toBeNull();
    expect(evidence.runs).toHaveLength(1);
    expect(evidence.runs[0]).toMatchObject({ id: f.runId, status: "succeeded", receipts: 4, duplicateReceipts: [`${sourceId}:evt-2`],
      terminalReceipt: true, nativeProducer: true, costAccounted: true, recordedCostCents: 25, costEventCents: 25, logBytes: 4096, logEvents: 0 });
    expect(evidence.companyCostEventCents).toBe(30);
    // A run of another company is never read, even when its id is passed.
    const other = await runningRun();
    expect((await collectContentionEvidence(db, f.companyId, [other.runId], null)).runs).toEqual([]);
  }, 60_000);
});
