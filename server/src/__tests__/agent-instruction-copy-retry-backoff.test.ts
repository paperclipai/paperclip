import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentInstructionWorkingCopies, authUsers, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import {
  agentInstructionWorkingCopyService,
  instructionCopyRetryAt,
  INSTRUCTION_COPY_MAX_RETRY_MS,
  INSTRUCTION_COPY_RETRY_MS,
} from "../services/agent-instruction-working-copies.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_INSTRUCTION_COPY_TEST_DATABASE_URL");
const AGENT_FILES = "paperclip.agent-files.v1";
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CONTENT = "# Instructions\n";
const CONTENT_HASH = createHash("sha256").update(CONTENT).digest("hex");

describe("instruction working copies that cannot make progress", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  let home: string;
  let companyId: string, agentId: string, userId: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-copy-backoff-")));
    process.env.PAPERCLIP_HOME = home;
    if (!external) database = await startEmbeddedPostgresTestDatabase("instruction-copy-backoff-db-");
    const url = external ?? database.connectionString;
    db = createDb(url, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 20 * 24 * 3600, connectTimeoutSeconds: 3600 });
    meter = meterDatabaseStatements(db, url);
  }, 90_000);
  afterAll(async () => {
    meter?.uninstall();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backoff", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed" } });
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.companyId, companyId));
  });

  const clock = () => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const coordinator = () => createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: () => {} });

  async function runs(count: number, finishedAgo: number, runtimeMode = "native") {
    const ids = Array.from({ length: count }, () => randomUUID());
    const finishedAt = new Date(Date.now() - finishedAgo);
    await db.insert(heartbeatRuns).values(ids.map(id => ({ id, companyId, agentId, status: "failed", runtimeMode,
      invocationSource: "on_demand", responsibleUserId: userId, startedAt: finishedAt, finishedAt })));
    return ids;
  }
  const entryPath = (runId: string) => path.join(home, "work", runId, ".paperclip-runtime", `instruction-edits-${runId}`, "instructions", "AGENTS.md");
  async function unprovenStops(count: number, finishedAgo: number) {
    const ids = await runs(count, finishedAgo);
    await db.insert(agentInstructionWorkingCopies).values(ids.map(runId => ({ runId, companyId, agentId, responsibleUserId: userId,
      entryFile: "AGENTS.md", baseHash: CONTENT_HASH, localRoot: path.dirname(entryPath(runId)), executionRoot: path.dirname(entryPath(runId)),
      location: "local", state: "prepared" })));
    for (const runId of ids) {
      await fs.mkdir(path.dirname(entryPath(runId)), { recursive: true });
      await fs.writeFile(entryPath(runId), CONTENT);
    }
    return ids;
  }
  async function stuckCleanups(count: number, options: { lockRoot?: boolean } = {}) {
    const ids = await runs(count, 0, "legacy");
    if (options.lockRoot !== false) for (const runId of ids) await fs.mkdir(path.join(home, "agents", agentId, "file-sync", "runs", runId, "live"), { recursive: true });
    await db.insert(agentInstructionWorkingCopies).values(ids.map(runId => {
      const localRoot = path.join(home, "agents", agentId, "file-sync", "runs", runId, "live");
      return { runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md", baseHash: CONTENT_HASH,
        localRoot, executionRoot: `/workspace/.paperclip-runtime/agent-files/${agentId}/${runId}`,
        location: `remote:${randomUUID()}`, state: "saved", processStoppedAt: new Date(), receipt: { schema: AGENT_FILES, state: "saved",
          cleanupPending: true, cleanup: { leaseId: randomUUID(), remoteCwd: "/workspace" }, materializationRunId: runId } };
    }));
    return ids;
  }
  async function copy(runId: string) {
    const [row] = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId));
    return row!;
  }
  async function settle() {
    let last = -1;
    for (let quiet = 0, turns = 0; quiet < 40 && turns < 20_000; turns++) {
      await new Promise(resolve => setImmediate(resolve));
      const current = meter.read().statements;
      quiet = current === last && idleWorkSnapshot().active === 0 ? quiet + 1 : 0;
      last = current;
    }
  }
  async function advance(ms: number, wakeAt: () => number | null) {
    const before = meter.read();
    meter.startLog();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const next = wakeAt();
      const quietUntil = next === null || next > end ? end : Math.max(Date.now(), next - 1000);
      if (quietUntil > Date.now()) await vi.advanceTimersByTimeAsync(quietUntil - Date.now());
      if (Date.now() >= end) break;
      for (let step = 0; step < 3; step++) { await vi.advanceTimersByTimeAsync(1000); await settle(); }
    }
    await settle();
    const log = meter.stopLog();
    const after = meter.read();
    return { statements: after.statements - before.statements, transactions: after.transactions - before.transactions,
      workSignals: log.filter(entry => entry.sql.includes("pg_current_xact_id")).length,
      stopChecks: log.filter(entry => entry.sql.includes(`from "heartbeat_run_events"`)).length,
      cleanupClaims: log.filter(entry => /^update "agent_instruction_working_copies" set "next_attempt_at" = \$1, "updated_at" = \$2 where/.test(entry.sql)).length };
  }
  async function start(...queues: Array<"collection" | "cleanup">) {
    const worker = coordinator();
    const service = agentInstructionWorkingCopyService(db);
    if (queues.includes("collection")) await service.registerStoppedCollectionWork(worker, () => true, async () => true).ready;
    if (queues.includes("cleanup")) await service.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
    await settle();
    return worker;
  }

  it("names a backoff that grows with the wait and stops growing at its cap", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    expect(INSTRUCTION_COPY_RETRY_MS).toBe(30_000);
    expect(INSTRUCTION_COPY_MAX_RETRY_MS).toBe(6 * HOUR);
    const delay = (waited: number) => instructionCopyRetryAt(new Date(now - waited), now).getTime() - now;
    expect([0, 30 * MINUTE, 2 * HOUR, 12 * HOUR, 30 * DAY].map(delay)).toEqual([30_000, 15 * MINUTE, HOUR, 6 * HOUR, 6 * HOUR]);
  });

  it("re-reads an old unproven stop on the capped backoff with five statements and no work signal", async () => {
    const [runId] = await unprovenStops(1, 2 * DAY);
    clock(); const worker = await start("collection");
    try {
      expect(await copy(runId!)).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED", attempts: 0 });
      expect((await copy(runId!)).nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(6 * HOUR - MINUTE);
      const window = await advance(12 * HOUR + MINUTE, worker.nextWakeAt);
      expect(window.stopChecks).toBe(2);
      expect(window.statements).toBe(10);
      expect(window.transactions).toBe(2);
      expect(window.workSignals).toBe(0);
      expect(await copy(runId!)).toMatchObject({ state: "pending_collection", attempts: 0, processStoppedAt: null });
    } finally { await worker.stop(); }
  }, 120_000);

  it("keeps re-checking a copy owned by a live older server and collects it once that server records the stop", async () => {
    const [runId] = await unprovenStops(1, 5 * MINUTE);
    clock(); const worker = await start("collection");
    try {
      const early = await advance(10 * MINUTE, worker.nextWakeAt);
      expect(early.stopChecks).toBeGreaterThanOrEqual(2);
      expect(await copy(runId!)).toMatchObject({ state: "pending_collection", processStoppedAt: null });
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: runId!, eventType: "native.local_process_stopped", stream: "system" });
      await advance(10 * MINUTE, worker.nextWakeAt);
      expect(await copy(runId!)).toMatchObject({ state: "unchanged", nextAttemptAt: null });
      expect((await copy(runId!)).processStoppedAt).not.toBeNull();
    } finally { await worker.stop(); }
  }, 120_000);

  it("collects a copy that waited for weeks within one capped backoff of its stop being recorded", async () => {
    const [runId] = await unprovenStops(1, 30 * DAY);
    clock(); const worker = await start("collection");
    try {
      await advance(HOUR, worker.nextWakeAt);
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: runId!, eventType: "native.local_process_stopped", stream: "system" });
      await advance(INSTRUCTION_COPY_MAX_RETRY_MS, worker.nextWakeAt);
      expect(await copy(runId!)).toMatchObject({ state: "unchanged", nextAttemptAt: null });
    } finally { await worker.stop(); }
  }, 120_000);

  it("drains a backlog of old unproven stops in bounded batches without work signals", async () => {
    await unprovenStops(300, 30 * DAY);
    const signals: string[] = [];
    const unsubscribe = [DELIVERY_QUEUES.instructionCollection, DELIVERY_QUEUES.strandedAgentStatus, DELIVERY_QUEUES.skillVersionRetention]
      .map(queue => subscribeDeliveryWork(db, queue, () => signals.push(queue)));
    clock(); const worker = coordinator();
    try {
      const before = meter.read();
      await agentInstructionWorkingCopyService(db).registerStoppedCollectionWork(worker, () => true, async () => true).ready;
      const drain = await advance(60_000, () => Date.now() + 1000);
      const rows = await db.select({ next: agentInstructionWorkingCopies.nextAttemptAt }).from(agentInstructionWorkingCopies)
        .where(eq(agentInstructionWorkingCopies.companyId, companyId));
      expect(rows.every(row => row.next!.getTime() - Date.now() > 5 * HOUR)).toBe(true);
      expect(meter.read().transactions - before.transactions).toBeLessThanOrEqual(300);
      expect(drain.stopChecks).toBeLessThanOrEqual(300);
      expect(drain.workSignals).toBe(0);
      expect(signals).toEqual([]);
      expect((await advance(HOUR, worker.nextWakeAt)).statements).toBe(0);
    } finally { unsubscribe.forEach(stop => stop()); await worker.stop(); }
  }, 120_000);

  it("still signals when a write moves the deadline earlier or changes queue membership", async () => {
    const [earlier, missing] = await unprovenStops(2, 2 * DAY);
    clock(); const worker = await start("collection");
    await worker.stop();
    const service = agentInstructionWorkingCopyService(db);
    const signals: string[] = [];
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.instructionCollection, () => signals.push("collection"));
    try {
      await fs.rm(entryPath(earlier!)); await fs.mkdir(entryPath(earlier!));
      await service.collectStopped({ companyId, runId: earlier! });
      expect(await copy(earlier!)).toMatchObject({ state: "pending_collection", attempts: 1, errorCode: "INSTRUCTION_COLLECTION_FAILED" });
      expect((await copy(earlier!)).nextAttemptAt!.getTime() - Date.now()).toBeLessThanOrEqual(INSTRUCTION_COPY_RETRY_MS);
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      await fs.rm(entryPath(missing!));
      await service.collectStopped({ companyId, runId: missing! });
      expect(await copy(missing!)).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_FILE_MISSING" });
      await vi.waitFor(() => expect(signals).toHaveLength(2));
    } finally { unsubscribe(); }
  }, 60_000);

  it.each([true, false])("backs off a cleanup that cannot finish and keeps the saved copy (cleanup throws: %s)", async throws => {
    const [runId] = await stuckCleanups(1, { lockRoot: !throws });
    clock(); const worker = await start("cleanup");
    try {
      const window = await advance(6 * HOUR, worker.nextWakeAt);
      expect(window.cleanupClaims).toBeGreaterThan(0);
      expect(window.workSignals).toBe(0);
      expect(window.cleanupClaims).toBeLessThanOrEqual(32);
      expect((await advance(6 * HOUR, worker.nextWakeAt)).cleanupClaims).toBeLessThanOrEqual(4);
      const row = await copy(runId!);
      expect(row).toMatchObject({ state: "saved", receipt: expect.objectContaining({ cleanupPending: true }) });
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    } finally { await worker.stop(); }
  }, 120_000);
});
