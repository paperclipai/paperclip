import { compareCents, usdToUnits } from "@paperclipai/shared";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { accountRunCost } from "../run-cost-accounting.js";
import { usageReceiptSpoolPath } from "../usage-receipts.js";
import { createNativeUsageDelivery } from "./native-usage-delivery.js";

const runnerRoot = fileURLToPath(new URL("../../../../packages/paperclip-runner/runner/", import.meta.url));
const fixtureProfile = process.env.CI ? "release" : "debug";
const billing = { provider: "openai", biller: "openai", billingType: "metered_api" as const };

describe("producer-owned native usage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    execFileSync("cargo", ["build", ...(fixtureProfile === "release" ? ["--release"] : []), "--locked",
      "--manifest-path", resolve(runnerRoot, "Cargo.toml"), "-p", "paperclip-runner-core", "--example", "recovery-fixture"],
    { timeout: 600_000, stdio: "pipe" });
    database = await startEmbeddedPostgresTestDatabase("native-usage-delivery-");
    db = createDb(database.connectionString);
  }, 660_000);
  afterAll(async () => { await database?.cleanup(); });
  const seed = async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Usage delivery", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Producer", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", runtimeMode: "native", costAccountingPending: true });
    return { companyId, agentId, runId, runnerInstanceId: randomUUID(), provider: { kind: "codex" as const, model: "test-model" }, billing };
  };
  const event = (input: Pick<Awaited<ReturnType<typeof seed>>, "runId" | "runnerInstanceId">, sequence: number, type: string, turnId = "turn-1", amount = 0.25): PrpEvent => ({
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: input.runnerInstanceId,
    sourceEventId: `usage-${sequence}`, sourceSeq: sequence, priority: 0, runId: input.runId,
    normalizedSessionId: "session-1", turnId, emittedAt: new Date().toISOString(), eventType: type,
    payload: type === "usage.reported" ? { runDeltaAvailable: true, runDeltaBasis: "run", runDelta: { inputTokens: 120, outputTokens: 10, providerCostUsd: amount } } : {},
  } as PrpEvent);

  it("retains the same Runner report through a failed Postgres receipt and an empty replacement receiver", async () => {
    const input = await seed();
    expect(existsSync(usageReceiptSpoolPath())).toBe(false);
    const root = mkdtempSync(resolve(tmpdir(), "native-usage-runner-"));
    const receiverA = resolve(root, "receiver-a"), receiverB = resolve(root, "receiver-b");
    const identity = { runnerInstanceId: input.runnerInstanceId, environmentLeaseId: randomUUID(), runId: input.runId,
      normalizedSessionId: randomUUID(), turnId: "turn-1", itemId: "item-1" };
    const expectedRunnerVersion = "0.3.0", expectedRunnerDigest = `sha256:${"c".repeat(64)}`;
    let receiver: ChildProcess | undefined, child: ChildProcess | undefined;
    let exit: Promise<unknown[]> | undefined, failed = 0, lastCaptureError = "";
    const receiptFile = resolve(root, "producer.json"), releaseFile = resolve(root, "release"), scriptFile = resolve(root, "script.json");
    writeFileSync(scriptFile, JSON.stringify({ steps: 3, waitAfter: 2, retentionLimit: 8, receiptFile, releaseFile, accounting: true }));
    const receipts = () => db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, input.runId));
    try {

      await db.execute(sql`CREATE FUNCTION fail_native_usage_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt database unavailable'; END $$`);
      await db.execute(sql`CREATE TRIGGER fail_native_usage BEFORE INSERT ON run_usage_receipts FOR EACH ROW EXECUTE FUNCTION fail_native_usage_receipt()`);
      const startReceiver = () => new Promise<ChildProcess>((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, ["--import", fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("./__fixtures__/usage-receiver.ts", import.meta.url))], {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)), stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...globalThis.process.env },
        });
        let diagnostics = "";
        process.stderr!.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-16000); });
        const timer = setTimeout(() => { process.kill("SIGKILL"); reject(new Error(`receiver startup timeout: ${diagnostics}`)); }, 60_000);
        process.once("exit", code => { clearTimeout(timer); reject(new Error(`receiver exited ${code}: ${diagnostics}`)); });
        process.on("message", message => {
          const kind = (message as { kind?: string }).kind;
          if (kind === "capture-failed") { failed++; lastCaptureError = String((message as { cause?: string }).cause); }
          if (kind === "ready") { clearTimeout(timer); resolve(process); }
        });
      });
      let requestId = 0;
      const request = (target: ChildProcess, value: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => { target.off("message", listener); reject(new Error("receiver response timeout")); }, 30_000);
        const listener = (message: unknown) => {
          const result = message as Record<string, unknown>;
          if (result.requestId !== id) return;
          clearTimeout(timer); target.off("message", listener);
          if (result.error) reject(new Error(String(result.error))); else resolve(result);
        };
        target.on("message", listener);
        target.send({ ...value, requestId: id });
      });
      receiver = await startReceiver();
      const firstReceiver = await request(receiver, { kind: "start", connectionString: database.connectionString, directory: receiverA, identity, input });
      const connectUrl = String(firstReceiver.connectUrl), port = Number(new URL(connectUrl).port), ticket = String(firstReceiver.ticket);
      child = spawn(resolve(runnerRoot, `target/${fixtureProfile}/examples/recovery-fixture`), ["--fixture-script", scriptFile, "--connect-url", connectUrl,
        "--state-dir", resolve(root, "producer"), "--runner-id", identity.runnerInstanceId, "--environment-lease-id", identity.environmentLeaseId,
        "--run-id", identity.runId, "--session-id", identity.normalizedSessionId, "--turn-id", identity.turnId, "--item-id", identity.itemId,
        "--runner-version", expectedRunnerVersion, "--runner-digest", expectedRunnerDigest, "--max-outbox-bytes", "65536", "--p0-reserve-bytes", "16384", "--reconnect-grace-ms", "120000"],
      { env: { ...process.env, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket }, stdio: ["ignore", "ignore", "pipe"] });
      exit = once(child, "exit");
      await request(receiver, { kind: "command", type: "turn.start", commandId: "start-once" });
      writeFileSync(releaseFile, "produce");
      await vi.waitFor(() => expect(failed).toBeGreaterThan(0), { timeout: 10_000 });
      expect(await receipts()).toHaveLength(0);
      const producerState = () => JSON.parse(readFileSync(resolve(root, "producer/runner-state.json"), "utf8")) as {
        outbox: Array<{ eventType: string; envelope: { payload: { sourceEventId: string } } }>;
      };
      const pendingUsage = producerState().outbox.find(report => report.eventType === "usage.reported");
      expect(pendingUsage).toBeDefined();
      const pendingSourceEventId = pendingUsage!.envelope.payload.sourceEventId;
      const stoppedReceiver = await request(receiver, { kind: "stop" });
      rmSync(receiverA, { recursive: true, force: true });
      await db.execute(sql`DROP TRIGGER fail_native_usage ON run_usage_receipts`);
      await db.execute(sql`DROP FUNCTION fail_native_usage_receipt()`);

      receiver = await startReceiver();
      await request(receiver, { kind: "start", connectionString: database.connectionString, directory: receiverB, identity, input, port, checkpoint: stoppedReceiver.checkpoint });
      await vi.waitFor(async () => expect((await receipts()).filter(row => row.complete)).toHaveLength(1), { timeout: 15_000 });
      await vi.waitFor(() => expect(producerState().outbox).toEqual([]), { timeout: 10_000 });
      expect((await receipts()).some(row => (row.receiptJson.producerEvent as Record<string, unknown>).sourceEventId === pendingSourceEventId)).toBe(true);
      expect((await receipts()).filter(row => row.receiptJson.producerEvent && (row.receiptJson.producerEvent as Record<string, unknown>).eventType === "usage.reported")).toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
      expect(await accountRunCost(db, input.runId)).toBe(true);
      expect(await accountRunCost(db, input.runId)).toBe(false);
      const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0].costCents).toBe(25);
      const failedBeforeLateReport = failed;
      await request(receiver, { kind: "command", type: "turn.steer", commandId: "release-late-usage" });
      await vi.waitFor(() => expect(failed).toBeGreaterThan(failedBeforeLateReport), { timeout: 10_000 });
      expect(lastCaptureError).toContain("native_usage_after_finalization_requires_reconciliation");
      const retainedLate = producerState().outbox.find(report => report.eventType === "usage.reported");
      expect(retainedLate).toBeDefined();
      expect(retainedLate!.envelope.payload).toMatchObject({ runId: input.runId, sourceInstanceId: input.runnerInstanceId });
      expect((await receipts()).filter(row => (row.receiptJson.producerEvent as Record<string, unknown>)?.eventType === "usage.reported")).toHaveLength(1);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId))).toHaveLength(1);
      expect(existsSync(usageReceiptSpoolPath())).toBe(false);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS fail_native_usage ON run_usage_receipts`);
      await db.execute(sql`DROP FUNCTION IF EXISTS fail_native_usage_receipt()`);
      if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill("SIGKILL");
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      rmSync(root, { force: true, recursive: true });
    }
  }, 240_000);

  it("preserves source takeover fencing, budget holds, and missing-usage debt", async () => {
    const input = await seed();
    const first = await createNativeUsageDelivery(db, input);
    await db.insert(budgetPolicies).values({ companyId: input.companyId, scopeType: "agent", scopeId: input.agentId,
      metric: "billed_cents", windowKind: "lifetime", amount: 10, notifyEnabled: false });
    await first.capture(event(input, 1, "usage.reported"));
    const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
    expect(agent.lifecycleHolds).toContain("budget");
    const replacement = { ...input, runnerInstanceId: randomUUID() };
    const second = await createNativeUsageDelivery(db, replacement);
    await second.capture(event(replacement, 1, "usage.reported", "turn-2", 0.5));
    await first.capture(event(input, 2, "turn.completed"));
    const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(pending.usageJson).toMatchObject({ costUsd: 0.5, accountingReceiptReady: false });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    expect(await accountRunCost(db, input.runId)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId))).toHaveLength(0);
    await second.capture(event(replacement, 2, "turn.completed", "turn-2"));
    expect(await accountRunCost(db, input.runId)).toBe(true);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId)))[0].costCents).toBe(50);
  });

  it.each(["tokens", "cost", "incomplete"])("accepts equal finalized snapshots and rejects changed %s without repricing", async change => {
    const input = await seed();
    const delivery = await createNativeUsageDelivery(db, input);
    await delivery.capture(event(input, 1, "usage.reported"));
    await delivery.capture(event(input, 2, "turn.completed"));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    expect(await accountRunCost(db, input.runId)).toBe(true);
    await delivery.capture(event(input, 3, "usage.reported"));
    const late = event(input, 4, "usage.reported");
    (late.payload as Record<string, unknown>).runDelta = { inputTokens: change === "tokens" ? 150 : 120, outputTokens: change === "tokens" ? 15 : 10, providerCostUsd: change === "incomplete" ? 0.25 : 0.5 };
    if (change === "incomplete") (late.payload as Record<string, unknown>).runDeltaAvailable = false;
    await expect(delivery.capture(late)).rejects.toThrow("native_usage_after_finalization_requires_reconciliation");
    await expect(delivery.capture(late)).rejects.toThrow("native_usage_after_finalization_requires_reconciliation");
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId)))[0].costCents).toBe(25);
  });

  it("accepts equal finalized rate-card reports without requiring terminal-only derived pricing", async () => {
    const input = { ...await seed(), provider: { kind: "codex" as const, model: "gpt-6.1-sol" } };
    const delivery = await createNativeUsageDelivery(db, input);
    const report = (sequence: number) => {
      const reported = event(input, sequence, "usage.reported");
      reported.payload = { runDeltaBasis: "run", runDeltaAvailable: true, runDelta: { inputTokens: 1000, outputTokens: 100000 } };
      return reported;
    };
    await delivery.capture(report(1));
    await delivery.capture(event(input, 2, "turn.completed"));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    expect(await accountRunCost(db, input.runId)).toBe(true);
    await delivery.capture(report(3));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(run.usageJson).toMatchObject({ pricingProvenance: { source: "rate_card" }, accountingReceiptReady: true });
    expect(usdToUnits(run.usageJson!.costUsdExact as string)).toBe(usdToUnits("1.002"));
    const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(100.2);
    const correction = report(4);
    (correction.payload as Record<string, unknown>).runDelta = { inputTokens: 1000, outputTokens: 100000, providerCostUsd: 2 };
    await expect(delivery.capture(correction)).rejects.toThrow("native_usage_after_finalization_requires_reconciliation");
  });

  it("keeps successor exposure pending after prior-turn accounting invalidates its live snapshot", async () => {
    const input = await seed();
    const delivery = await createNativeUsageDelivery(db, input);
    const paid = event(input, 1, "usage.reported");
    paid.payload = { runDeltaBasis: "run", runDeltaAvailable: true, runDelta: { inputTokens: 50, outputTokens: 5, providerCostUsd: 0.5 } };
    await delivery.capture(paid);
    const invalidated = event(input, 2, "usage.reported");
    invalidated.payload = { runDeltaBasis: "run", runDeltaAvailable: false, runDelta: {}, reason: "accounting_reconciliation_required",
      reconciliation: { receivedTurnId: "old-provider-turn", cumulative: { inputTokens: 120, outputTokens: 12 }, priorOrigin: { runId: "old-run" } } };
    await delivery.capture(invalidated);
    await delivery.capture(event(input, 3, "turn.failed"));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "codex_usage_accounting_integrity", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(run).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      usageJson: { accountingReceiptReady: false, costStatus: "unpriced" } });
    expect(compareCents((run.usageJson?.budgetExposure as { costCents: string }).costCents, "50")).toBe(0);
    const [required] = await db.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.runId, input.runId), eq(runUsageReceipts.sequence, 2)));
    expect(required.receiptJson.producerEvent).toMatchObject({ usage: { reconciliation: { receivedTurnId: "old-provider-turn", cumulative: { inputTokens: 120 }, priorOrigin: { runId: "old-run" } } } });
    expect(await accountRunCost(db, input.runId)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId))).toHaveLength(0);
  });

  it("retains unmarked legacy Codex reports as incomplete unpriced debt", async () => {
    const input = { ...await seed(), provider: { kind: "codex" as const, model: "gpt-6.1-sol" } };
    const delivery = await createNativeUsageDelivery(db, input);
    const legacy = event(input, 1, "usage.reported");
    delete (legacy.payload as Record<string, unknown>).runDeltaBasis;
    await delivery.capture(legacy);
    await delivery.capture(event(input, 2, "turn.completed"));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)))[0]).toMatchObject({
      costAccountingPending: true, costAccountedAt: null, usageJson: { accountingReceiptReady: false, costStatus: "unpriced" } });
    expect(await accountRunCost(db, input.runId)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, input.runId))).toHaveLength(0);
  });

  it("replays partial and final usage once after a lost commit response and restores turn aggregation", async () => {
    const input = { ...await seed(), provider: { kind: "opencode" as const, model: "test-model" } };
    let loseResponse = false;
    const failingDb = new Proxy(db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<Db["transaction"]>) => {
        const result = await db.transaction(...args);
        if (loseResponse) { loseResponse = false; throw new Error("lost commit response"); }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    let delivery = await createNativeUsageDelivery(failingDb, input);
    const first = event(input, 1, "usage.reported"), done = event(input, 2, "turn.completed");
    loseResponse = true;
    await expect(delivery.capture(first)).rejects.toThrow("lost commit response");
    await delivery.capture(first);
    await delivery.capture(done);
    delivery = await createNativeUsageDelivery(db, input);
    await delivery.capture(first);
    await delivery.capture(done);
    const nextTurn = event(input, 3, "turn.started", "turn-1");
    nextTurn.payload = { providerTurnId: "provider-turn-2" };
    await delivery.capture(nextTurn);
    const partial = event(input, 4, "usage.reported", "turn-1", 0.5);
    (partial.payload as Record<string, unknown>).runDeltaAvailable = false;
    await delivery.capture(partial);
    const final = event(input, 5, "usage.reported", "turn-1", 0.5);
    await delivery.capture(final);
    const terminal = event(input, 6, "turn.completed", "turn-1");
    terminal.payload = { providerTurnId: "provider-turn-2" };
    await delivery.capture(terminal);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(run.usageJson).toMatchObject({ inputTokens: 240, outputTokens: 20, accountingReceiptReady: true, costUsd: 0.75 });
    expect(run.usageJson?.accountingCaptureFailed).not.toBe(true);
    expect(await db.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.runId, input.runId), eq(runUsageReceipts.sequence, 1)))).toHaveLength(1);
    await expect(delivery.capture({ ...final, payload: { ...final.payload as object, runDeltaAvailable: false } })).rejects.toThrow("native_usage_source_conflict");
  });
});
