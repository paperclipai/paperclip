import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, issues, nativeRunFinalizations, runUsageReceipts } from "@paperclipai/db";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { accountRunCost } from "./run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, usageReceiptSpoolPath } from "./usage-receipts.js";

describe("closed native usage settlement", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID(), agentId = randomUUID();
  const settlement = { schema: "paperclip.accounting.settlement/v1", providerWorkEnded: true, usageComplete: false } as const;
  const partial: AdapterUsageCheckpoint = { provider: "deepseek", biller: "openrouter", model: "fixture-model",
    billingType: "metered_api", usageBasis: "per_run", complete: false, costStatus: "unpriced",
    costUsd: 0.25, costUsdExact: "0.250000000", settlement };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "native-usage-settlement-"));
    process.env.PAPERCLIP_HOME = home;
    temporary = await startEmbeddedPostgresTestDatabase("native-usage-settlement-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Usage settlement", issuePrefix: "USE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", adapterType: "paperclip_runner", status: "idle" });
  });
  afterAll(async () => {
    await temporary?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
  });
  async function createRun() {
    const runId = randomUUID(), issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Settle attempted usage", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "failed", finishedAt: new Date(), costAccountingPending: true,
      usageJson: { ledgerScope: { issueId }, inputTokens: 99, outputTokens: 5 } });
    return { runId, issueId, recorder: await createRunUsageRecorder(db, { companyId, runId, adapterType: "paperclip_runner" }) };
  }
  async function readRun(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run;
  }

  it("settles a retry's known subtotal exactly once after provider closure without inventing tokens", async () => {
    const { runId, issueId, recorder } = await createRun();
    // A previous accepted request's counters are not the complete retry total.
    await recorder.capture({ ...partial, settlement: undefined, usage: { inputTokens: 20, outputTokens: 2 } });
    const receipt = await recorder.complete({ exitCode: 1, signal: null, timedOut: false, ...partial, usageComplete: false });
    expect(receipt).toMatchObject({ complete: false, settlement, costUsdExact: "0.250000000" });
    expect(receipt.usage).toBeUndefined();
    const pending = await readRun(runId);
    expect(pending.usageJson).toMatchObject({ inputTokens: null, outputTokens: null, accountingUsageComplete: false, accountingReceiptReady: true });
    await db.insert(nativeRunFinalizations).values({ runId, issueId, companyId, phase: "observed" });
    expect(await accountRunCost(db, runId)).toBe(false);
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    expect(await accountRunCost(db, runId)).toBe(false);
    const [journal] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, String(pending.usageJson?.accountingReceiptId)));
    await persistUsageReceipt(db, journal.receiptJson as Parameters<typeof persistUsageReceipt>[1]);
    expect(await accountRunCost(db, runId)).toBe(false);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    expect(events).toHaveLength(1);
    expect(Number(events[0].costCents)).toBe(25);
    expect(events[0].costStatus).toBe("unpriced");
    expect(await readRun(runId)).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
  });

  it("keeps a legacy incomplete checkpoint pending without closure authority", async () => {
    const { runId, recorder } = await createRun();
    await recorder.complete({ exitCode: 1, signal: null, timedOut: false, ...partial, settlement: undefined, usageComplete: false });
    expect(await accountRunCost(db, runId)).toBe(false);
    expect(await readRun(runId)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
  });

  it("does not use a closed later attempt to settle an unfinished attempt", async () => {
    const { runId, recorder } = await createRun();
    await recorder.capture({ ...partial, attemptId: randomUUID(), settlement: undefined });
    const receipt = await recorder.capture({ ...partial, attemptId: randomUUID() });
    expect(receipt.settlement).toBeUndefined();
    expect(await accountRunCost(db, runId)).toBe(false);
  });

  it("cannot mint closure from an invalid settlement or a later capture failure", async () => {
    const { runId, recorder } = await createRun();
    await expect(recorder.capture({ ...partial, settlement: { ...settlement, schema: "unknown/v1" } } as unknown as AdapterUsageCheckpoint)).rejects.toThrow();
    await recorder.complete({ exitCode: 1, signal: null, timedOut: false, ...partial, usageComplete: false });
    expect(await accountRunCost(db, runId)).toBe(false);
    expect((await readRun(runId)).usageJson).toMatchObject({ accountingCaptureFailed: true, accountingReceiptReady: false });
  });

  it("preserves v1 replay while rejecting settlement that disagrees with completeness", async () => {
    const { runId, recorder } = await createRun();
    await expect(recorder.capture({ ...partial, complete: true })).rejects.toThrow("Settlement must preserve usage completeness");
    expect(await accountRunCost(db, runId)).toBe(false);
    expect(usageReceiptSpoolPath().startsWith(home)).toBe(true);
  });
});
