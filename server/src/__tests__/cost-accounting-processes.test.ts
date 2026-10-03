import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { replayUsageReceipts } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const root = fileURLToPath(new URL("../../..", import.meta.url));
(support.supported && process.platform !== "win32" ? describe : describe.skip)("accounting across process and connection failures", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("accounting-processes-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Process", issuePrefix: `P${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
    return { company, agent };
  }
  function worker(mode: string, input: unknown) {
    return spawn(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", "server/src/__tests__/fixtures/accounting-writer.ts", mode, JSON.stringify(input)], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PAPERCLIP_ACCOUNTING_TEST_DATABASE: database.connectionString, PAPERCLIP_TELEMETRY_DISABLED: "1" },
    });
  }
  it("deduplicates the same receipt from independent server processes", async () => {
    const f = await fixture();
    const receipt = { agentId: f.agent.id, provider: "fixture", model: "fixture", costCents: "0.1234567", idempotencyKey: "shared-key", occurredAt: new Date().toISOString() };
    const children = Array.from({ length: 4 }, () => worker("write", { companyId: f.company.id, receipt }));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        let log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
        child.once("error", reject); child.once("exit", code => code === 0 && log.includes("WRITES_COMMITTED") ? resolve() : reject(new Error(log)));
      })));
      expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id)))).toHaveLength(1);
      expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
    } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL"); }
  }, 45_000);

  it("recovers a receipt after SIGKILL before its first database persistence", async () => {
    const f = await fixture(); const directory = await mkdtemp(path.join(tmpdir(), "accounting-early-kill-"));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", costAccountingPending: true, usageJson: { accountingReceiptReady: false } }).returning();
    const child = worker("receipt", { companyId: f.company.id, runId: run.id, directory });
    try {
      await new Promise<void>((resolve, reject) => {
        let log = ""; child.stdout.on("data", data => { log += data; if (log.includes("RECEIPT_DURABLE")) resolve(); });
        child.stderr.on("data", data => log += data); child.once("error", reject); child.once("exit", () => reject(new Error(`Exited before checkpoint: ${log}`)));
      });
      const stopped = new Promise(resolve => child.once("exit", resolve)); process.kill(-child.pid!, "SIGKILL"); await stopped;
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toEqual([]);
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      expect(await replayUsageReceipts(db, directory)).toEqual({ replayed: 1, failed: 0 });
      expect(await accountRunCost(db, run.id)).toBe(true);
      expect(await accountRunCost(db, run.id)).toBe(false);
      expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("1.2345678");
      expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("retries safely when PostgreSQL commits but its acknowledgement is lost", async () => {
    const f = await fixture(); const target = new URL(database.connectionString); const sockets = new Set<Socket>(); let dropped = false;
    // Parse PostgreSQL server frames, suppress precisely CommandComplete(COMMIT),
    // then break TCP. The database has committed while the writer sees failure.
    const proxy = createServer(client => {
      const upstream = createConnection({ host: target.hostname, port: Number(target.port) }); sockets.add(client); sockets.add(upstream);
      client.on("error", () => {}); upstream.on("error", () => client.destroy()); client.pipe(upstream);
      let pending = Buffer.alloc(0);
      upstream.on("data", chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
          const size = pending.readInt32BE(1) + 1;
          if (size < 5 || size > 16 * 1024 * 1024) { client.destroy(); upstream.destroy(); return; }
          if (pending.length < size) return;
          const message = pending.subarray(0, size); pending = pending.subarray(size);
          if (!dropped && message[0] === 67 && message.subarray(5).toString() === "COMMIT\0") {
            dropped = true; client.destroy(); upstream.destroy(); return;
          }
          client.write(message);
        }
      });
      client.on("close", () => { sockets.delete(client); upstream.destroy(); });
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const forwarded = new URL(database.connectionString); forwarded.hostname = "127.0.0.1"; forwarded.port = String((proxy.address() as { port: number }).port); forwarded.searchParams.set("sslmode", "disable");
    const writer = createDb(forwarded.toString());
    const receipt = { agentId: f.agent.id, provider: "fixture", model: "fixture", costCents: "0.9999999", idempotencyKey: "ambiguous-commit", occurredAt: new Date() };
    try {
      await expect(costService(writer).createEvent(f.company.id, receipt)).rejects.toThrow();
      expect(dropped).toBe(true);
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(1);
      await costService(writer).createEvent(f.company.id, receipt);
      expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("0.9999999");
      expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
    } finally {
      await writer.$client.end({ timeout: 1 }); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 30_000);
});
