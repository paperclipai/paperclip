import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("idle accounting work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("idle-accounting-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function recorder() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting idle test", issuePrefix: "ACCT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "idle-accounting-"));
    directories.push(directory);
    let offline = false;
    const proxy = new Proxy(db, { get(target, property) {
      if (property === "transaction" && offline) return () => Promise.reject(new Error("Database unavailable"));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    const recorder = await createRunUsageRecorder(proxy, { companyId, runId, adapterType: "process" }, directory);
    return { recorder, directory, runId, setOffline: (value: boolean) => { offline = value; } };
  }

  it("counts queued receipts until capture and accounting writes settle", async () => {
    const before = idleWorkSnapshot().active;
    const { recorder: usage } = await recorder();
    const first = usage.capture({ complete: false, usage: { inputTokens: 1, outputTokens: 1 } });
    const second = usage.capture({ complete: true, usage: { inputTokens: 2, outputTokens: 2 } });
    expect(idleWorkSnapshot().active).toBe(before + 2);
    await Promise.all([first, second]);
    await usage.persistFailure();
    expect(idleWorkSnapshot().active).toBe(before);
  });

  it("keeps unpersisted capture failure as a blocker until its failure fence reaches the database", async () => {
    const before = idleWorkSnapshot().active;
    const { recorder: usage, directory, runId, setOffline } = await recorder();
    await fs.rm(directory, { recursive: true });
    await fs.writeFile(directory, "unwritable spool");
    setOffline(true);
    await expect(usage.capture({ complete: true, usage: { inputTokens: 1, outputTokens: 1 } })).rejects.toThrow();
    await expect(usage.persistFailure()).rejects.toThrow();
    expect(idleWorkSnapshot().active).toBe(before + 1);
    setOffline(false);
    // A successful query which updates zero rows is not a durable fence.
    await db.update(heartbeatRuns).set({ costAccountedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await usage.persistFailure();
    expect(idleWorkSnapshot().active).toBe(before + 1);
    await db.update(heartbeatRuns).set({ costAccountedAt: null }).where(eq(heartbeatRuns.id, runId));
    await usage.persistFailure();
    expect(idleWorkSnapshot().active).toBe(before);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountingPending).toBe(true);
    expect(run.usageJson?.accountingCaptureFailed).toBe(true);
  });
});
