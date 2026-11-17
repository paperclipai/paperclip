import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, agentTaskSessions, companies, createDb, environmentLeases, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunnerCheckpoints,
} from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { nativeHarnessBackupExpirationService } from "../services/native-runtime/native-harness-backup-expiration.js";
import { registerNativeHarnessBackupExpirationWork } from "../services/native-runtime/native-harness-backup-expiration-work.js";
import { notifyRetainedNativeSessionCleanup } from "../services/retained-native-session-cleanup-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const describeEmbeddedPostgres = recoveryPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("native retention blockers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let meter!: ReturnType<typeof meterDatabaseStatements>;
  let stateBase = "";
  const now = new Date();

  beforeAll(async () => {
    tempDb = await startRecoveryPostgres("paperclip-native-retention-blockers-");
    db = createDb(tempDb.connectionString);
    meter = meterDatabaseStatements(db, tempDb.connectionString);
  }, 30_000);
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(nativeRunnerCheckpoints);
    await db.delete(agentTaskSessions);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
    stateBase = "";
  });
  afterAll(async () => {
    meter?.uninstall();
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedSessions(count: number, input: { runsPerSession?: number; issueStatus?: string; closedDaysAgo?: number; backup?: boolean } = {}) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retention-blockers-"));
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Coder" }).returning();
    const finishedAt = new Date(now.getTime() - 10 * DAY_MS);
    const status = input.issueStatus ?? "todo";
    const closedAt = new Date(now.getTime() - (input.closedDaysAgo ?? 10) * DAY_MS);
    const sessions = [];
    for (let index = 0; index < count; index++) {
      const [issue] = await db.insert(issues).values({ companyId, title: "Work", status,
        completedAt: status === "done" ? closedAt : null }).returning();
      const sessionId = randomUUID();
      const runs = await db.insert(heartbeatRuns).values(Array.from({ length: input.runsPerSession ?? 3 }, () => ({
        companyId, agentId: agent!.id, status: "succeeded", issueId: issue!.id, nativeIssueId: issue!.id,
        nativeSessionId: sessionId, finishedAt,
      }))).returning();
      await db.insert(nativeRunFinalizations).values(runs.map(run => ({ runId: run.id, companyId, issueId: issue!.id, phase: "committed" })));
      await db.insert(nativeRunnerCheckpoints).values(runs.map(run => ({
        companyId, issueId: issue!.id, runId: run.id, part: "header", material: { encrypted: true },
      })));
      const scope = createHash("sha256").update(randomUUID()).digest("hex");
      if (input.backup) {
        const root = path.join(stateBase, scope);
        const current = path.join(root, "failover-backups", "current");
        await fs.mkdir(path.join(root, "control-plane"), { recursive: true });
        await fs.writeFile(path.join(root, "control-plane", "control-plane-state.json"),
          JSON.stringify({ identity: { runId: runs[0]!.id, normalizedSessionId: sessionId } }));
        await fs.mkdir(current, { recursive: true });
        await fs.writeFile(path.join(current, "manifest.json"), "{}");
        await fs.utimes(current, finishedAt, finishedAt);
      }
      sessions.push({ companyId, agentId: agent!.id, issueId: issue!.id, sessionId, scope, runIds: runs.map(run => run.id) });
    }
    return sessions;
  }

  function service() {
    return nativeHarnessBackupExpirationService(db, { stateBase, closedForDays: 7, isSessionBusy: () => false });
  }

  async function startup() {
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const before = meter.read();
    try {
      await service().registerCheckpointExpiration(coordinator).ready;
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 60_000 });
    } finally { await coordinator.stop(); }
    const after = meter.read();
    return { statements: after.statements - before.statements, transactions: after.transactions - before.transactions };
  }

  it("evaluates blocked checkpoint sessions in one statement per page and repeats nothing per checkpoint on restart", async () => {
    await seedSessions(100);
    const first = await startup();
    const second = await startup();
    expect(first).toEqual({ statements: 4, transactions: 0 });
    expect(second).toEqual(first);
    expect(await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints)).toHaveLength(300);
  }, 120_000);

  it("expires the checkpoints of a session on the next startup once its blocker clears", async () => {
    const [blocked] = await seedSessions(1);
    const cleared = await seedSessions(2, { issueStatus: "done", closedDaysAgo: 9 });
    await startup();
    const remaining = await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints);
    expect(remaining.map(row => row.runId).sort()).toEqual([...blocked!.runIds].sort());
    expect(cleared.flatMap(session => session.runIds).some(runId => remaining.some(row => row.runId === runId))).toBe(false);
    await db.update(issues).set({ status: "done", completedAt: new Date(now.getTime() - 8 * DAY_MS) }).where(eq(issues.id, blocked!.issueId));
    await startup();
    expect(await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints)).toEqual([]);
  }, 120_000);

  it("keeps a checkpoint whose session still has a resume pointer", async () => {
    const [session] = await seedSessions(1, { issueStatus: "done", closedDaysAgo: 9 });
    await db.insert(agentTaskSessions).values({ companyId: session!.companyId, agentId: session!.agentId, adapterType: "paperclip_runner",
      taskKey: session!.issueId, sessionParamsJson: { sessionId: session!.sessionId }, lastRunId: session!.runIds[0]! });
    expect(await startup()).toEqual({ statements: 2, transactions: 0 });
    expect(await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints)).toHaveLength(3);
  }, 120_000);

  it("lets two servers run the startup pass at once without duplicate or conflicting retirement", async () => {
    const sessions = await seedSessions(20, { issueStatus: "done", closedDaysAgo: 9 });
    const [left, right] = await Promise.all([service().tickCheckpoints(), service().tickCheckpoints()]);
    expect(left.failed + right.failed).toBe(0);
    expect(left.expiredCheckpoints + right.expiredCheckpoints).toBe(sessions.length * 3);
    expect(await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints)).toEqual([]);
  }, 120_000);

  it("reads a blocked backup in one statement for each run hint that reaches it", async () => {
    const sessions = await seedSessions(50, { backup: true, runsPerSession: 1 });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: () => {} });
    const worker = registerNativeHarnessBackupExpirationWork(coordinator, db, { stateBase, isSessionBusy: () => false }, () => true);
    try {
      await worker.ready;
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
      const before = meter.read();
      meter.startLog();
      for (const session of sessions) await db.transaction(tx => notifyRetainedNativeSessionCleanup(tx, { companyId: session.companyId, runId: session.runIds[0]! }));
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 30_000 });
      await vi.advanceTimersByTimeAsync(5000);
      const log = meter.stopLog();
      const after = meter.read();
      const hintWrites = sessions.length * 3;
      expect(after.transactions - before.transactions).toBe(sessions.length);
      expect(after.statements - before.statements - hintWrites).toBeLessThanOrEqual(sessions.length * 2);
      expect(log.filter(entry => entry.sql.includes("jsonb_to_recordset")).length).toBe(sessions.length);
      for (const session of sessions) expect(await fs.lstat(path.join(stateBase, session.scope, "failover-backups", "current")).then(() => true)).toBe(true);
    } finally { await worker.stop(); await coordinator.stop(); }
  }, 120_000);
});
