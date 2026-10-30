import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { captureRecoveredNativeUsageCheckpoint, persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("usage receipt PostgreSQL reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("usage-receipt-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Receipt fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Receipt agent", adapterType: "process", status: "active" });
    const payload = randomBytes(128 * 1024).toString("base64");
    const evidence = { contextSnapshot: { prompt: payload }, runnerProfileJson: { instructions: payload },
      resultJson: { stdout: payload }, stdoutExcerpt: payload, stderrExcerpt: payload };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", ...evidence,
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, preserved: "receipt metadata" } });
    const receipt = (sequence: number): UsageReceiptEnvelope => ({ schema: "paperclip/accounting-receipt/v1",
      id: randomUUID(), companyId, runId, sourceId, sequence, receivedAt: new Date().toISOString(), adapterType: "process",
      receipt: { complete: false, usageBasis: "per_run", costUsd: sequence / 100, billingType: "metered_api" } });
    return { companyId, runId, evidence, receipt };
  }

  it("updates live usage with a small locked read and preserves all execution evidence", async () => {
    const f = await fixture(), reads: unknown[][] = [];
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (callback: Parameters<Db["transaction"]>[0]) => target.transaction(tx => callback(new Proxy(tx, {
        get(transaction, property) {
          if (property !== "select") return Reflect.get(transaction, property);
          return (...fields: Parameters<Db["select"]>) => {
            const builder = transaction.select(...fields), from = builder.from.bind(builder);
            builder.from = ((...args: Parameters<typeof from>) => {
              const query = from(...args);
              if (args[0] === heartbeatRuns) {
                const execute = query.execute.bind(query);
                query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                  expect(query.toSQL().sql).toContain("for update");
                  const rows = await execute(...executeArgs); reads.push(rows); return rows;
                };
              }
              return query;
            }) as typeof builder.from;
            return builder;
          };
        },
      })));
    } });
    await persistUsageReceipt(observed, f.receipt(1));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(reads))).toBeLessThan(2048);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored).toMatchObject(f.evidence);
    expect(stored.usageJson).toMatchObject({ preserved: "receipt metadata", accountingReceiptSequence: 1,
      budgetExposure: { costCents: "1.0000000" } });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(512 * 1024);
  });

  it("serializes competing checkpoints and retains replay conflicts and company isolation", async () => {
    const f = await fixture(), first = f.receipt(1), second = f.receipt(2);
    await Promise.all([persistUsageReceipt(db, first), persistUsageReceipt(db, second)]);
    await persistUsageReceipt(db, first);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored.usageJson).toMatchObject({ accountingReceiptSequence: 2, budgetExposure: { costCents: "2.0000000" } });
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(2);
    await expect(persistUsageReceipt(db, { ...first, receipt: { ...first.receipt, costUsd: 10 } })).rejects.toThrow("Conflicting");
    const foreign = await fixture();
    await expect(persistUsageReceipt(db, { ...f.receipt(3), companyId: foreign.companyId })).rejects.toThrow("not found");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(stored);
  });

  it("captures a terminal native Codex checkpoint under the same source and sequence fence", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    const spool = await mkdtemp(path.join(tmpdir(), "native-usage-recovery-"));
    try {
      await db.insert(companies).values({ id: companyId, name: "Native receipt fixture", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Native receipt agent", adapterType: "paperclip_runner", status: "active" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native",
        costAccountingPending: true, usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0,
          accountingReceiptReady: false, accountingProviderWorkStarted: true } });
      const initial: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId, runId,
        sourceId, sequence: 1, receivedAt: new Date().toISOString(), adapterType: "paperclip_runner",
        receipt: { complete: false, usageBasis: "per_run", provider: "openai", biller: "openai", model: "fixture-model",
          billingType: "metered_api", costUsd: null, costStatus: "unpriced", pricingProvenance: { source: "unknown", version: "accounting-receipt/v1" },
          usage: { inputTokens: 4, outputTokens: 2 } } };
      await persistUsageReceipt(db, initial);

      const capture = () => captureRecoveredNativeUsageCheckpoint(db, { companyId, runId, sourceFingerprint: "a".repeat(64),
        expectedSourceId: sourceId, expectedSequence: 1,
        usage: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 7 } }, spool);
      const outcomes = await Promise.all([capture(), capture()]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(saved).toMatchObject({ status: "failed", costAccountingPending: true, costAccountedAt: null,
        usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 2, accountingReceiptReady: true,
          accountingProviderWorkStarted: true, inputTokens: 90, cachedInputTokens: 30, outputTokens: 7,
          billingType: "metered_api", costUsd: null, costUsdExact: null, costStatus: "unpriced" } });
      expect(saved.usageJson?.accountingCaptureFailed).not.toBe(true);
      const receipts = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, runId));
      expect(receipts).toHaveLength(2);
      expect(receipts[1]?.receiptJson).toMatchObject({ sourceId, sequence: 2,
        recovery: { kind: "native_codex_rollout", previousSequence: 1, sourceFingerprint: "a".repeat(64) },
        receipt: { complete: true, usageBasis: "per_run", costUsd: null, costStatus: "unpriced",
          usage: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 7 } } });
      expect(receipts[1]?.receiptJson).toMatchObject({ receipt: { costUsd: null, costStatus: "unpriced",
        pricingProvenance: { source: "unknown", version: "accounting-receipt/v1" } } });
      expect(await capture()).toBe(false);
      await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptSourceId: randomUUID(), accountingReceiptSequence: 1,
        accountingReceiptReady: false } }).where(eq(heartbeatRuns.id, runId));
      expect(await capture()).toBe(false);
      await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 2,
        accountingReceiptReady: false, accountingCaptureFailed: true } }).where(eq(heartbeatRuns.id, runId));
      expect(await capture()).toBe(false);
    } finally {
      await rm(spool, { recursive: true, force: true });
    }
  });

  it("does not replace a previously reported monetary amount with an unpriced token checkpoint", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    const spool = await mkdtemp(path.join(tmpdir(), "native-usage-priced-recovery-"));
    try {
      await db.insert(companies).values({ id: companyId, name: "Priced native receipt fixture", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Priced native receipt agent", adapterType: "paperclip_runner", status: "active" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native",
        costAccountingPending: true, usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, accountingReceiptReady: false } });
      await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId, runId,
        sourceId, sequence: 1, receivedAt: new Date().toISOString(), adapterType: "paperclip_runner",
        receipt: { complete: false, usageBasis: "per_run", billingType: "metered_api", costUsd: 0.25, costStatus: "reported" } });
      expect(await captureRecoveredNativeUsageCheckpoint(db, { companyId, runId, sourceFingerprint: "c".repeat(64),
        expectedSourceId: sourceId, expectedSequence: 1, usage: { inputTokens: 20, outputTokens: 3 } }, spool)).toBe(false);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(saved.usageJson).toMatchObject({ accountingReceiptSourceId: sourceId, accountingReceiptSequence: 1,
        accountingReceiptReady: false, costUsd: 0.25 });
      expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, runId))).toHaveLength(1);
    } finally {
      await rm(spool, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly included subscription zero while completing token evidence", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    const spool = await mkdtemp(path.join(tmpdir(), "native-usage-subscription-recovery-"));
    try {
      await db.insert(companies).values({ id: companyId, name: "Subscription receipt fixture", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Subscription receipt agent", adapterType: "paperclip_runner", status: "active" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native",
        costAccountingPending: true, usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, accountingReceiptReady: false } });
      await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId, runId,
        sourceId, sequence: 1, receivedAt: new Date().toISOString(), adapterType: "paperclip_runner", liveCostCents: "0",
        receipt: { complete: false, usageBasis: "per_run", billingType: "subscription_included", costUsd: null, costStatus: "unpriced" } });
      expect(await captureRecoveredNativeUsageCheckpoint(db, { companyId, runId, sourceFingerprint: "d".repeat(64),
        expectedSourceId: sourceId, expectedSequence: 1, usage: { inputTokens: 20, outputTokens: 3 } }, spool)).toBe(true);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(saved.usageJson).toMatchObject({ accountingReceiptReady: true, billingType: "subscription_included",
        costStatus: "unpriced", costUsd: null, inputTokens: 20, outputTokens: 3 });
    } finally {
      await rm(spool, { recursive: true, force: true });
    }
  });
});
