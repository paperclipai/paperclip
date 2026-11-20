/**
 * Run-row accounting writers under concurrent run-row updates (real PostgreSQL).
 *
 * Streamed run-log appends, output progress and lifecycle events update the
 * same `heartbeat_runs` row that budget admission and the usage recorder lock.
 * A repeatable-read snapshot taken before that lock goes stale whenever one of
 * those writes commits first, and four retries could not outlast a busy stream
 * (restart-chaos L1 with `--db-pressure`). The deterministic cases commit a real
 * run-event append after the writer's transaction validates the company and
 * before it locks the run, on every attempt, which is the race a stream produces.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, budgetEvaluationWork, budgetPolicies, budgetReservations, companies, createDb, heartbeatRuns, runUsageReceipts, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  ACCOUNTING_TRANSACTION_ATTEMPTS, AccountingContentionError, isAccountingContentionError, withOperationAccountingTransaction,
} from "./accounting-transaction.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { createRunUsageRecorder, spoolUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("run accounting writers under concurrent run-row updates", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-accounting-contention-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(options: { status?: "queued" | "running"; limitCents?: number; reservationCents?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Contention lab", issuePrefix: `C${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    if (options.limitCents !== undefined) {
      await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents",
        windowKind: "calendar_month_utc", amount: options.limitCents, reservationCents: options.reservationCents ?? "0",
        notifyEnabled: false, unpricedUsagePolicy: "allow" });
    }
    const run = async (status = options.status ?? "queued") => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", status }).returning();
      return row.id;
    };
    return { companyId, agentId, run };
  }

  /** Commit a real run-event append after the accounting transaction checks
   * the company (its first statement, which starts the snapshot) and before
   * it locks the run. Fires on every attempt, so a snapshot-sensitive writer
   * exhausts its retries deterministically. */
  function interleaveRunEvents(f: { companyId: string; agentId: string }, runId: string) {
    let interleavings = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (callback: Parameters<Db["transaction"]>[0], options: Parameters<Db["transaction"]>[1]) => {
        // Only accounting transactions (which name an isolation level). A plain
        // transaction can already hold the run lock where it reads companies.
        let first = Boolean(options?.isolationLevel);
        return target.transaction(tx => callback(new Proxy(tx, { get(transaction, property) {
          if (property !== "select") return Reflect.get(transaction, property);
          return (...fields: Parameters<Db["select"]>) => {
            const builder = transaction.select(...fields), from = builder.from.bind(builder);
            builder.from = ((...args: Parameters<typeof from>) => {
              const query = from(...args);
              if (args[0] === companies && first) {
                first = false;
                const execute = query.execute.bind(query);
                query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                  const rows = await execute(...executeArgs);
                  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId, agentId: f.agentId,
                    eventType: "lifecycle", message: "stream advanced" });
                  interleavings++;
                  return rows;
                };
              }
              return query;
            }) as typeof builder.from;
            return builder;
          };
        } })), options);
      };
    } });
    return { db: observed, interleavings: () => interleavings };
  }

  /** Back-to-back single-row writes, like a fast stream, until stopped. */
  function pressure(runId: string, writers = 4) {
    const client = createDb(database.connectionString).$client;
    let running = true, updates = 0;
    const loops = Array.from({ length: writers }, async () => {
      while (running) {
        await client.unsafe("update heartbeat_runs set updated_at = updated_at where id = $1", [runId]);
        updates++;
      }
    });
    return {
      updates: () => updates,
      async stop() { running = false; await Promise.all(loops); await client.end(); },
    };
  }

  async function steady(writers: ReturnType<typeof pressure>) {
    while (writers.updates() < 50) await new Promise(resolve => setTimeout(resolve, 5));
  }

  describe("reserveRunBudget", () => {
    it("reserves once when run events commit between its company check and its run lock", async () => {
      const f = await fixture({ limitCents: 1_000, reservationCents: "100" });
      const runId = await f.run();
      const hooked = interleaveRunEvents(f, runId);
      await expect(reserveRunBudget(hooked.db, f.companyId, runId, null)).resolves.toMatchObject({ reused: false });
      expect(hooked.interleavings()).toBe(1);
      expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))).toHaveLength(1);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      // The admission write and the concurrent stream write both survive.
      expect(run.costAccountingPending).toBe(true);
      expect(run.nextEventSeq).toBe(2);
    });

    it("reserves every run while back-to-back writers update the run row", async () => {
      const f = await fixture({ limitCents: 100_000, reservationCents: "1" });
      for (let i = 0; i < 6; i++) {
        const runId = await f.run();
        const writers = pressure(runId);
        await steady(writers);
        try {
          await expect(reserveRunBudget(db, f.companyId, runId, null)).resolves.toMatchObject({ reused: false });
        } finally { await writers.stop(); }
      }
    }, 60_000);

    it("never creates a second reservation for one run when two dispatches race", async () => {
      const f = await fixture({ limitCents: 1_000, reservationCents: "100" });
      const runId = await f.run();
      const outcomes = await Promise.allSettled([
        reserveRunBudget(db, f.companyId, runId, null), reserveRunBudget(db, f.companyId, runId, null),
      ]);
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ status: 409, message: "Provider dispatch has already reserved this run" });
      expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))).toHaveLength(1);
    });

    it("counts every committed hold, so successive admissions never exceed the budget", async () => {
      // Each reservation fits alone; the third would exceed 250 cents.
      const f = await fixture({ limitCents: 250, reservationCents: "100" });
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const runId = await f.run();
        const hooked = interleaveRunEvents(f, runId);
        results.push(await reserveRunBudget(hooked.db, f.companyId, runId, null).then(() => "reserved",
          (error: Error) => error.message));
      }
      expect(results).toEqual(["reserved", "reserved", "Available budget is reserved by unfinished runs"]);
      const [held] = await db.select({ cents: sql<string>`sum(${budgetReservations.amountCents})::text` }).from(budgetReservations)
        .where(and(eq(budgetReservations.companyId, f.companyId), eq(budgetReservations.state, "held")));
      expect(Number(held.cents)).toBeLessThanOrEqual(250);
    });

    it("still refuses a run once the hard stop is reached", async () => {
      const f = await fixture({ limitCents: 100 });
      // Another run's observed spend already exceeds the limit.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment",
        status: "running", costAccountingPending: true, usageJson: { costUsd: 2, billingType: "metered_api" } });
      const runId = await f.run();
      const hooked = interleaveRunEvents(f, runId);
      await expect(reserveRunBudget(hooked.db, f.companyId, runId, null)).rejects.toMatchObject({ status: 409 });
      expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))).toHaveLength(0);
    });
  });

  describe("final dispatch gate", () => {
    it("admits and hands off a reserved run when run events commit between its company check and its run lock", async () => {
      const f = await fixture({ limitCents: 1_000, reservationCents: "100" });
      const runId = await f.run();
      const reservation = await reserveRunBudget(db, f.companyId, runId, null);
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
      const hooked = interleaveRunEvents(f, runId);
      let dispatched = 0;
      const outcome = await createPostgresRunDispatchAdapter(hooked.db).dispatchResolvedInteractionIfCurrent({
        companyId: f.companyId, runId, reservationId: (reservation as { id: string }).id, expectedStatus: "running",
        now: new Date(), dispatch: async () => { dispatched++; } });
      expect(outcome).toMatchObject({ dispatched: true });
      expect(dispatched).toBe(1);
      expect(hooked.interleavings()).toBe(1);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run.usageJson?.budgetDispatch).toMatchObject({ reservationId: (reservation as { id: string }).id });
      expect((run.usageJson?.budgetDispatch as { handedOffAt?: string }).handedOffAt).toBeTruthy();
    });

    it("admits while back-to-back writers update the run row", async () => {
      const f = await fixture({ limitCents: 100_000, reservationCents: "1" });
      for (let i = 0; i < 6; i++) {
        const runId = await f.run();
        const reservation = await reserveRunBudget(db, f.companyId, runId, null);
        await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
        const writers = pressure(runId);
        await steady(writers);
        try {
          await expect(createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId,
            reservationId: (reservation as { id: string }).id, expectedStatus: "running", now: new Date(), dispatch: async () => {} }))
            .resolves.toMatchObject({ dispatched: true });
        } finally { await writers.stop(); }
      }
    }, 60_000);
  });

  describe("createRunUsageRecorder", () => {
    const spool = () => fs.mkdtemp(path.join(os.tmpdir(), "run-accounting-contention-"));

    it("binds its receipt source when run events commit between its company check and its run lock", async () => {
      const f = await fixture({ status: "running" });
      const runId = await f.run();
      const directory = await spool();
      // A receipt the previous controller spooled but never committed: the
      // handoff journals it exactly once.
      const previousSource = randomUUID();
      await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptSourceId: previousSource, accountingReceiptSequence: 0 } })
        .where(eq(heartbeatRuns.id, runId));
      const pending: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId: f.companyId,
        runId, sourceId: previousSource, sequence: 1, receivedAt: new Date().toISOString(), adapterType: "process",
        receipt: { complete: false, usageBasis: "per_run", costUsd: 0.01, billingType: "metered_api" } };
      await spoolUsageReceipt(pending, directory);
      try {
        const hooked = interleaveRunEvents(f, runId);
        await expect(createRunUsageRecorder(hooked.db, { companyId: f.companyId, runId, adapterType: "process" }, directory)).resolves.toBeTruthy();
        expect(hooked.interleavings()).toBe(1);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(run.usageJson).toMatchObject({ accountingReceiptSequence: 0, accountingReceiptReady: false,
          accountingReceiptSourceFences: { [previousSource]: 1 } });
        expect(run.usageJson?.accountingReceiptSourceId).not.toBe(previousSource);
        expect(run.nextEventSeq).toBe(2);
        expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, runId))).toHaveLength(1);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    it("persists its capture-failure fence once when run events commit between its company check and its run lock", async () => {
      const f = await fixture({ status: "running" });
      const runId = await f.run();
      const directory = await spool();
      try {
        const hooked = interleaveRunEvents(f, runId);
        const recorder = await createRunUsageRecorder(hooked.db, { companyId: f.companyId, runId, adapterType: "process" }, directory);
        // A checkpoint the schema rejects fails the capture; the recorder then
        // fences the run as capture-failed in its own accounting transaction.
        await expect(recorder.capture(null as never)).rejects.toThrow();
        await recorder.persistFailure();
        // Handoff, fence and the repeated fence call each saw one concurrent
        // run-event append.
        expect(hooked.interleavings()).toBe(3);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(run.usageJson).toMatchObject({ accountingCaptureFailed: true, accountingReceiptReady: false });
        expect(run).toMatchObject({ costAccountingPending: true, accountingLastError: "usage_capture_failed", nextEventSeq: 4 });
        // One evaluation input for the handoff and one for the fence; the
        // repeated persistFailure call found the fence already committed.
        expect(await db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, f.companyId))).toHaveLength(2);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    it("binds while back-to-back writers update the run row", async () => {
      const f = await fixture({ status: "running" });
      for (let i = 0; i < 6; i++) {
        const runId = await f.run();
        const directory = await spool();
        const writers = pressure(runId);
        await steady(writers);
        try {
          await expect(createRunUsageRecorder(db, { companyId: f.companyId, runId, adapterType: "process" }, directory)).resolves.toBeTruthy();
        } finally { await writers.stop(); await fs.rm(directory, { recursive: true, force: true }); }
      }
    }, 60_000);
  });

  describe("exhausted retries", () => {
    it("fail with a bounded, SQL-free cause that keeps the SQLSTATE", async () => {
      const f = await fixture({ status: "running" });
      const runId = await f.run();
      const hooked = interleaveRunEvents(f, runId);
      // A writer that still uses a repeatable-read snapshot loses every attempt.
      const error = await withOperationAccountingTransaction(hooked.db, f.companyId, async tx => {
        await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
      }).then(() => null, (failure: unknown) => failure);
      expect(hooked.interleavings()).toBe(ACCOUNTING_TRANSACTION_ATTEMPTS);
      expect(error).toBeInstanceOf(AccountingContentionError);
      expect(isAccountingContentionError(error)).toBe(true);
      const contention = error as AccountingContentionError;
      expect(contention).toMatchObject({ code: "40001", attempts: ACCOUNTING_TRANSACTION_ATTEMPTS, status: 503 });
      expect(contention.message).not.toMatch(/select|heartbeat_runs|Failed query|params/i);
      // The database error stays attached for the server log only.
      expect(String((contention.cause as Error).message)).toMatch(/^Failed query: select/);
    });
  });
});
