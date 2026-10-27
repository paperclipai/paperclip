import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";

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
});
