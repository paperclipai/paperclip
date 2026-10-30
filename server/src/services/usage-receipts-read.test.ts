import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { persistUsageReceipt, recoverPendingRunUsageReceipts, type UsageReceiptEnvelope } from "./usage-receipts.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("usage receipt PostgreSQL reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("usage-receipt-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function spool(receipt: UsageReceiptEnvelope) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-receipt-scan-"));
    directories.push(directory);
    const file = path.join(directory, `${receipt.id}.json`);
    await fs.writeFile(file, JSON.stringify(receipt));
    return { directory, file };
  }

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

  it.each([false, true])("recovers its own receipt despite concurrent removal of other runs (foreign company: %s)", async foreignCompany => {
    const f = await fixture(), receipt = f.receipt(1);
    const { directory, file } = await spool(receipt);
    const other = { ...f.receipt(1), runId: randomUUID(), companyId: foreignCompany ? randomUUID() : f.companyId };
    const foreignFiles = new Set<string>();
    async function publishOther() {
      const otherFile = path.join(directory, `${randomUUID()}.json`);
      await fs.writeFile(otherFile, JSON.stringify(other));
      foreignFiles.add(otherFile);
    }
    await publishOther();
    async function removeOther(file: string) {
      if (!foreignFiles.delete(file)) return;
      await fs.unlink(file);
      await publishOther();
    }
    const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const info = await lstat(...args);
      await removeOther(String(args[0]));
      return info;
    }) as typeof fs.lstat);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      await removeOther(String(args[0]));
      return handle;
    });
    expect(await recoverPendingRunUsageReceipts(db, f, directory, { retainFiles: true })).toEqual([file]);
    expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(receipt));
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toMatchObject([{ id: receipt.id }]);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, other.runId))).toHaveLength(0);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored.usageJson).toMatchObject({ accountingReceiptSequence: 1, accountingReceiptId: receipt.id });
  });

  it("recovers its own receipt when journaled foreign checkpoints disappear before acquisition", async () => {
    const f = await fixture(), receipt = f.receipt(1), foreign = await fixture();
    const { directory, file } = await spool(receipt);
    const others = [foreign.receipt(1), foreign.receipt(2), foreign.receipt(3)];
    for (const other of others) await persistUsageReceipt(db, other);
    const readdir = fs.readdir.bind(fs);
    let scans = 0;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const other = others[scans++];
      if (!other) throw new Error("Unexpected extra scan");
      const foreignFile = path.join(directory, `${other.id}.json`);
      await fs.writeFile(foreignFile, JSON.stringify(other));
      const names = await readdir(...args);
      await fs.unlink(foreignFile);
      return names;
    }) as typeof fs.readdir);
    expect(await recoverPendingRunUsageReceipts(db, f, directory, { retainFiles: true })).toEqual([file]);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toMatchObject([{ id: receipt.id }]);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, foreign.runId))).toHaveLength(3);
  });

  it("checks 64 vanished journaled foreign receipts in at most one query per scan", async () => {
    const f = await fixture(), foreign = await fixture();
    const others = Array.from({ length: 64 }, (_, index) => foreign.receipt(index + 1));
    const { directory, file } = await spool(others[0]);
    await persistUsageReceipt(db, others[0]);
    for (const receipt of others.slice(1)) {
      await persistUsageReceipt(db, receipt);
      await fs.writeFile(path.join(directory, `${receipt.id}.json`), JSON.stringify(receipt));
    }
    const readdir = fs.readdir.bind(fs);
    let scans = 0, journalQueries = 0;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const names = await readdir(...args);
      scans++;
      await Promise.all(names.map(name => fs.unlink(path.join(directory, String(name)))));
      return names;
    }) as typeof fs.readdir);
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          if (args[0] === runUsageReceipts) journalQueries++;
          return from(...args);
        }) as typeof builder.from;
        return builder;
      };
    } });
    expect(await recoverPendingRunUsageReceipts(observed, f, directory)).toEqual([]);
    expect(scans).toBe(1);
    expect(journalQueries).toBeLessThanOrEqual(scans);
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("journals its own receipt even when a replayer renames the acquired file", async () => {
    const f = await fixture(), receipt = f.receipt(1);
    const { directory, file } = await spool(receipt);
    let current = file;
    async function move(file: string) {
      if (file !== current) return;
      const renamed = path.join(directory, `retry-${randomUUID()}.json`);
      await fs.rename(current, renamed);
      current = renamed;
    }
    const lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const info = await lstat(...args);
      await move(String(args[0]));
      return info;
    }) as typeof fs.lstat);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      await move(String(args[0]));
      return handle;
    });
    expect(await recoverPendingRunUsageReceipts(db, f, directory, { retainFiles: true })).toEqual([file]);
    expect(await fs.readFile(current, "utf8")).toBe(JSON.stringify(receipt));
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toMatchObject([{ id: receipt.id }]);
  });

  it("rescans an unidentified receipt renamed before it can be opened", async () => {
    const f = await fixture(), receipt = f.receipt(1);
    const { directory, file } = await spool(receipt);
    const renamed = path.join(directory, `retry-${randomUUID()}.json`);
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce((async (...args: Parameters<typeof fs.readdir>) => {
      const names = await readdir(...args);
      await fs.rename(file, renamed);
      return names;
    }) as typeof fs.readdir);
    expect(await recoverPendingRunUsageReceipts(db, f, directory)).toEqual([renamed]);
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toMatchObject([{ id: receipt.id }]);
  });

  it("fails closed when unjournaled UUID-named receipts repeatedly vanish before acquisition", async () => {
    const f = await fixture(), first = f.receipt(1);
    const { directory, file } = await spool(first);
    const readdir = fs.readdir.bind(fs);
    let current = file, scans = 0;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const names = await readdir(...args);
      await fs.unlink(current);
      scans++;
      if (scans < 3) {
        const next = f.receipt(scans + 1);
        current = path.join(directory, `${next.id}.json`);
        await fs.writeFile(current, JSON.stringify(next));
      }
      return names;
    }) as typeof fs.readdir);
    await expect(recoverPendingRunUsageReceipts(db, f, directory)).rejects.toThrow("Accounting spool changed during recovery");
    expect(scans).toBe(3);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(0);
  });

  it("does not certify recovery when unidentified receipts keep moving before acquisition", async () => {
    const f = await fixture(), receipt = f.receipt(1);
    const { directory, file } = await spool(receipt);
    let current = file;
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const names = await readdir(...args);
      const renamed = path.join(directory, `retry-${randomUUID()}.json`);
      await fs.rename(current, renamed);
      current = renamed;
      return names;
    }) as typeof fs.readdir);
    await expect(recoverPendingRunUsageReceipts(db, f, directory)).rejects.toThrow("Accounting spool changed during recovery");
    expect(await fs.readFile(current, "utf8")).toBe(JSON.stringify(receipt));
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(0);
  });

  it("ignores non-files, oversized entries, and invalid JSON without following symbolic links", async () => {
    const f = await fixture(), receipt = f.receipt(1);
    const { directory, file } = await spool(receipt);
    await fs.mkdir(path.join(directory, "directory.json"));
    await fs.writeFile(path.join(directory, "oversized.json"), " ".repeat(1024 * 1024 + 1));
    await fs.writeFile(path.join(directory, "invalid.json"), "{");
    const hidden = path.join(directory, "hidden-receipt");
    await fs.writeFile(hidden, JSON.stringify(f.receipt(2)));
    await fs.symlink(hidden, path.join(directory, "symlink.json"));
    expect(await recoverPendingRunUsageReceipts(db, f, directory)).toEqual([file]);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored.usageJson).toMatchObject({ accountingReceiptSequence: 1, accountingReceiptId: receipt.id });
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(1);
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
