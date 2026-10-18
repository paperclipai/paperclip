import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { recoverInterruptedRunUsageFromSession, recoverPendingInterruptedRunUsage } from "../services/usage-session-recovery.js";

const support = await getEmbeddedPostgresTestSupport();

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function writePiSession(sessionPath: string, messages: Array<{ id: string; timestamp: string; usage?: Record<string, number> | null; cost?: number | null }>) {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: messages[0]?.timestamp ?? new Date().toISOString(), cwd: "/tmp" }),
    ...messages.map((message) =>
      JSON.stringify({
        type: "message",
        id: message.id,
        parentId: null,
        timestamp: message.timestamp,
        message: {
          role: "assistant",
          content: "ok",
          provider: "test-provider",
          model: "test-model",
          ...(message.usage === null || message.usage === undefined
            ? {}
            : {
                usage: {
                  input: message.usage.input,
                  output: message.usage.output,
                  cacheRead: message.usage.cacheRead ?? 0,
                  cacheWrite: 0,
                  reasoning: 0,
                  totalTokens: (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.output ?? 0),
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: message.cost ?? 0,
                  },
                },
              }),
        },
      }),
    ),
  ];
  await fs.writeFile(sessionPath, `${lines.join("\n")}\n`);
}

(support.supported ? describe : describe.skip)("usage session recovery for interrupted runs", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("usage-session-recovery-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(input: {
    status: "cancelled" | "interrupted";
    errorCode: string;
    sessionMessages: Array<{ id: string; timestamp: string; usage?: Record<string, number> | null; cost?: number | null }>;
    capturedUsage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number } | null;
    capturedCostUsd?: number | null;
    finishedMinutesAgo?: number;
  }) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery test", issuePrefix: "REC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi agent", role: "engineer", status: "idle", adapterType: "pi_local" });
    const startedAt = new Date(Date.now() - 60 * 60_000);
    const finishedAt = new Date(Date.now() - (input.finishedMinutesAgo ?? 10) * 60_000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt,
    });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-session-recovery-"));
    directories.push(directory);
    const sessionPath = path.join(directory, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${agentId}.jsonl`);
    await writePiSession(sessionPath, input.sessionMessages);

    const spool = await fs.mkdtemp(path.join(os.tmpdir(), "usage-session-recovery-spool-"));
    directories.push(spool);
    const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "pi_local" }, spool);
    // The adapter binds its session reference before the process starts, so
    // even a run killed before its first usage checkpoint stays recoverable.
    await recorder.capture({
      complete: false,
      usage: { inputTokens: 0, outputTokens: 0 },
      usageBasis: "per_run",
      sessionRef: sessionPath,
      provider: "test-provider",
      model: "test-model",
      billingType: "unknown",
    });
    if (input.capturedUsage) {
      await recorder.capture({
        complete: false,
        usage: input.capturedUsage,
        usageBasis: "per_run",
        sessionRef: sessionPath,
        provider: "test-provider",
        model: "test-model",
        billingType: "unknown",
        costUsd: input.capturedCostUsd ?? null,
      });
    }
    await db.update(heartbeatRuns).set({
      status: input.status,
      errorCode: input.errorCode,
      error: "Interrupted",
      finishedAt,
      costAccountingPending: true,
      resultJson: { executionRecovery: { providerWorkStarted: true } },
    }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, runId, sessionPath, recorder };
  }

  async function readRun(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run;
  }

  it("recovers completed-turn usage for an operator-interrupted run and settles its cost receipt", async () => {
    const fixtureData = await fixture({
      status: "cancelled",
      errorCode: "operator_interrupted",
      // Two completed turns reached the live checkpoint stream before the Stop;
      // the third turn was in flight and has no usage record in the session.
      capturedUsage: { inputTokens: 100, outputTokens: 10 },
      capturedCostUsd: 0.5,
      sessionMessages: [
        { id: "m1", timestamp: new Date(Date.now() - 55 * 60_000).toISOString(), usage: { input: 100, cacheRead: 20, output: 10 }, cost: 0.5 },
        { id: "m2", timestamp: new Date(Date.now() - 50 * 60_000).toISOString(), usage: { input: 200, cacheRead: 30, output: 20 }, cost: 1.25 },
        // Partial in-flight turn: no usage record, so it must be left out.
        { id: "m3", timestamp: new Date(Date.now() - 45 * 60_000).toISOString(), usage: null, cost: null },
      ],
    });

    const sweep = await recoverPendingInterruptedRunUsage(db);
    expect(sweep).toContainEqual(expect.objectContaining({ recovered: true, runId: fixtureData.runId }));

    const run = await readRun(fixtureData.runId);
    expect(object(run.usageJson).accountingReceiptReady).toBe(true);
    expect(object(run.usageJson).usageSource).toBe("recovered_stream");
    expect(object(run.usageJson).inputTokens).toBe(300);
    expect(object(run.usageJson).cachedInputTokens).toBe(50);
    expect(object(run.usageJson).outputTokens).toBe(30);
    expect(object(run.usageJson).costUsd).toBeCloseTo(1.75, 10);

    // Settlement keeps the run receipt and the ledger event in one transaction.
    const accounted = await accountRunCost(db, fixtureData.runId);
    expect(accounted).toBe(true);
    const [event] = await db.select().from(costEvents).where(and(eq(costEvents.companyId, fixtureData.companyId), eq(costEvents.heartbeatRunId, fixtureData.runId)));
    expect(event).toBeTruthy();
    expect(event.inputTokens).toBe(300);
    expect(event.cachedInputTokens).toBe(50);
    expect(event.outputTokens).toBe(30);
    expect(event.costCents).toBe(175);
    expect(event.agentId).toBe(fixtureData.agentId);

    const settled = await readRun(fixtureData.runId);
    expect(settled.costAccountedAt).not.toBeNull();
    expect(object(settled.usageJson).accountingReceiptReady).toBe(true);

    // The recovered receipt stays in the audit journal.
    const journal = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, fixtureData.runId));
    const recovered = journal.map((row) => object(row.receiptJson)).find((row) => object(row.receipt).usageSource === "recovered_stream");
    expect(recovered).toBeTruthy();
  });

  it("recovers a server-shutdown-interrupted run after a restart and keeps it idempotent", async () => {
    const fixtureData = await fixture({
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      // No checkpoint survived the SIGTERM: only the session file remains.
      capturedUsage: null,
      sessionMessages: [
        { id: "m1", timestamp: new Date(Date.now() - 55 * 60_000).toISOString(), usage: { input: 1000, cacheRead: 200, output: 100 }, cost: 3.06 },
      ],
    });

    const recovered = await recoverInterruptedRunUsageFromSession(db, { companyId: fixtureData.companyId, runId: fixtureData.runId });
    expect(recovered).toEqual({ recovered: true, runId: fixtureData.runId, reason: null });

    const run = await readRun(fixtureData.runId);
    expect(object(run.usageJson).accountingReceiptReady).toBe(true);
    expect(object(run.usageJson).inputTokens).toBe(1000);
    expect(object(run.usageJson).usageSource).toBe("recovered_stream");

    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: expect.any(Number) });
    const [event] = await db.select().from(costEvents).where(and(eq(costEvents.companyId, fixtureData.companyId), eq(costEvents.heartbeatRunId, fixtureData.runId)));
    expect(event.costCents).toBe(306);

    // Re-running the sweep must not recover or settle the same run twice.
    const again = await recoverInterruptedRunUsageFromSession(db, { companyId: fixtureData.companyId, runId: fixtureData.runId });
    expect(again).toEqual({ recovered: false, runId: fixtureData.runId, reason: "already_accounted" });
    expect(await accountRunCost(db, fixtureData.runId)).toBe(false);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, fixtureData.runId));
    expect(events).toHaveLength(1);
  });

  it("waits for the grace window so a just-interrupted run is not recovered before its executor settles", async () => {
    const fixtureData = await fixture({
      status: "cancelled",
      errorCode: "operator_interrupted",
      finishedMinutesAgo: 0,
      capturedUsage: { inputTokens: 100, outputTokens: 10 },
      capturedCostUsd: 0.5,
      sessionMessages: [
        { id: "m1", timestamp: new Date(Date.now() - 5_000).toISOString(), usage: { input: 100, cacheRead: 20, output: 10 }, cost: 0.5 },
      ],
    });
    const result = await recoverInterruptedRunUsageFromSession(db, { companyId: fixtureData.companyId, runId: fixtureData.runId });
    expect(result).toEqual({ recovered: false, runId: fixtureData.runId, reason: "grace_pending" });
    const run = await readRun(fixtureData.runId);
    expect(object(run.usageJson).accountingReceiptReady).toBe(false);
  });

  it("never lets a stale session erase the usage the live stream already captured", async () => {
    const fixtureData = await fixture({
      status: "cancelled",
      errorCode: "operator_interrupted",
      capturedUsage: { inputTokens: 500, outputTokens: 50 },
      capturedCostUsd: 2,
      sessionMessages: [
        // The session file holds less than the captured checkpoint.
        { id: "m1", timestamp: new Date(Date.now() - 55 * 60_000).toISOString(), usage: { input: 10, cacheRead: 0, output: 1 }, cost: 0.02 },
      ],
    });
    const result = await recoverInterruptedRunUsageFromSession(db, { companyId: fixtureData.companyId, runId: fixtureData.runId });
    expect(result).toEqual({ recovered: false, runId: fixtureData.runId, reason: "recovered_usage_regressed" });
    const run = await readRun(fixtureData.runId);
    expect(object(run.usageJson).inputTokens).toBe(500);
    expect(object(run.usageJson).accountingReceiptReady).toBe(false);
  });

  it("leaves runs without a durable session reference pending instead of guessing", async () => {
    const fixtureData = await fixture({
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      capturedUsage: null,
      sessionMessages: [
        { id: "m1", timestamp: new Date(Date.now() - 55 * 60_000).toISOString(), usage: { input: 100, cacheRead: 0, output: 10 }, cost: 0.5 },
      ],
    });
    // Simulate a run whose checkpoints never persisted the session path.
    await db.update(heartbeatRuns).set({
      usageJson: { accountingReceiptReady: false, accountingReceiptSourceId: randomUUID(), accountingReceiptSequence: 0, ledgerScope: { issueId: null, projectId: null, billingCode: null } },
    }).where(eq(heartbeatRuns.id, fixtureData.runId));
    const result = await recoverInterruptedRunUsageFromSession(db, { companyId: fixtureData.companyId, runId: fixtureData.runId });
    expect(result).toEqual({ recovered: false, runId: fixtureData.runId, reason: "no_session_ref" });
  });
});
