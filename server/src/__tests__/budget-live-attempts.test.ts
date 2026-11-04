import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { computeObservedSpend } from "../services/budgets.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { createRunUsageRecorder, replayUsageReceipts, type UsageReceiptEnvelope } from "../services/usage-receipts.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("live budget exposure across recorder attempts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-live-attempts-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(rejectedZero = true) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Live attempts", issuePrefix: "LAT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Provider", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false }).returning();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "budget-live-attempts-"));
    directories.push(directory);
    let offline = false;
    const proxy = new Proxy(db, { get(target, property) {
      if (property === "transaction" && offline) return () => Promise.reject(new Error("Database unavailable"));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    const recorder = await createRunUsageRecorder(proxy, { companyId, runId, adapterType: "codex_local" }, directory);
    const identity = { usageBasis: "per_run" as const, provider: "openai", biller: "openai",
      billingType: "metered_api" as const, model: "gpt-6.1-sol" };
    if (rejectedZero) await recorder.capture({ ...identity, attemptId: randomUUID(), complete: true,
      usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, costStatus: "reported" });
    const paidAttemptId = randomUUID();
    const partial = { ...identity, attemptId: paidAttemptId, complete: false,
      usage: { inputTokens: 1000, outputTokens: 100000 }, costStatus: "unpriced" as const };
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    return { companyId, agentId, runId, policy, directory, proxy, recorder, identity, partial, readRun,
      offline: (value: boolean) => { offline = value; } };
  }

  it("enforces a token-priced retry while preserving final receipt uncertainty and one ledger charge", async () => {
    const f = await fixture();
    await f.recorder.capture(f.partial);
    expect(await computeObservedSpend(db, f.policy)).toMatchObject({ liveObservedCents: "100.2000000" });
    const partial = await f.readRun();
    expect(partial.usageJson).toMatchObject({ costUsdExact: "0.000000000", costStatus: "unpriced",
      accountingReceiptReady: false, budgetExposure: { costCents: "100.2000000" } });
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].lifecycleHolds).toContain("budget");

    await f.recorder.capture({ ...f.partial, complete: true, costUsd: 0.8, costStatus: "reported" });
    expect((await f.readRun()).usageJson?.accountingReceiptReady).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await accountRunCost(db, f.runId)).toBe(true);
    expect(await computeObservedSpend(db, f.policy)).toMatchObject({ liveObservedCents: "0.0000000", ledgerCents: "80.0000000" });
    expect(await db.select().from(costEvents)).toHaveLength(1);
  });

  it("replays the fsynced per-attempt exposure after a failed database write", async () => {
    const f = await fixture();
    f.offline(true);
    await f.recorder.capture(f.partial);
    const files = (await fs.readdir(f.directory)).filter(file => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, files[0]), "utf8")) as UsageReceiptEnvelope;
    expect(saved).toMatchObject({ liveCostCents: "100.2000000", receipt: { complete: false, costStatus: "unpriced", costUsdExact: "0.000000000" } });
    expect((await computeObservedSpend(db, f.policy)).liveObservedCents).toBe("0.0000000");
    f.offline(false);
    await replayUsageReceipts(f.proxy, f.directory);
    expect((await computeObservedSpend(db, f.policy)).liveObservedCents).toBe("100.2000000");
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].lifecycleHolds).toContain("budget");
    expect((await fs.readdir(f.directory)).filter(file => file.endsWith(".json"))).toEqual([]);
  });

  it("uses normalized per-run exposure instead of cumulative USD retained in aggregate compatibility fields", async () => {
    const f = await fixture();
    await f.recorder.capture({ ...f.identity, attemptId: randomUUID(), usageBasis: "session_cumulative",
      complete: true, costUsd: 100, usage: { inputTokens: 100, outputTokens: 100 } });
    await f.recorder.capture({ ...f.identity, attemptId: randomUUID(), complete: false,
      costUsd: 0.2, usage: { inputTokens: 20, outputTokens: 20 } });
    expect((await f.readRun()).usageJson).toMatchObject({ costUsdExact: "100.200000000",
      usageSource: "per_run", budgetExposure: { costCents: "20.0000000" } });
    expect((await computeObservedSpend(db, f.policy)).liveObservedCents).toBe("20.0000000");
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].lifecycleHolds).not.toContain("budget");
  });

  it("does not resurrect cumulative USD when the normalized per-run attempt remains unpriced", async () => {
    const f = await fixture(false);
    await db.insert(budgetReservations).values({ companyId: f.companyId, agentId: f.agentId, runId: f.runId, amountCents: "10" });
    await f.recorder.capture({ ...f.identity, attemptId: randomUUID(), usageBasis: "session_cumulative",
      complete: true, costUsd: 100, usage: { inputTokens: 100, outputTokens: 100 } });
    const unknownAttemptId = randomUUID();
    await f.recorder.capture({ ...f.identity, attemptId: unknownAttemptId, model: "unsupported", complete: false,
      usage: { inputTokens: 20, outputTokens: 20 } });
    await f.recorder.capture({ ...f.identity, attemptId: unknownAttemptId, model: "unsupported", complete: false,
      usage: { inputTokens: 30, outputTokens: 30 } });
    expect((await f.readRun()).usageJson).toMatchObject({ costUsdExact: "100.000000000",
      costStatus: "unpriced", accountingReceiptReady: false, usageSource: "per_run", budgetExposure: { costCents: null } });
    expect(await computeObservedSpend(db, f.policy)).toMatchObject({ liveObservedCents: "0.0000000", effectiveHeldCents: "10.0000000" });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.runId)))[0].state).toBe("held");
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await db.select().from(costEvents)).toEqual([]);
  });
});
