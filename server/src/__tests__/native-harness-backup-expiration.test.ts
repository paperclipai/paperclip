import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { nativeHarnessBackupExpirationService } from "../services/native-runtime/native-harness-backup-expiration.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native harness backup expiration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("native harness backup expiration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let stateBase = "";
  const now = new Date();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-backup-expiration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
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
    await tempDb?.cleanup();
  });

  async function seedSession(input: {
    issueStatus?: string;
    closedDaysAgo?: number;
    runStatus?: string;
    finalization?: { phase: string; recoveryState?: string | null };
    leaseStatus?: string;
    backupAgeDays?: number;
    cleanupActive?: boolean;
  } = {}) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backups", issuePrefix: `B${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Coder" }).returning();
    const issueStatus = input.issueStatus ?? "done";
    const closedAt = new Date(now.getTime() - (input.closedDaysAgo ?? 10) * DAY_MS);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Closed work",
      status: issueStatus,
      completedAt: issueStatus === "done" ? closedAt : null,
      cancelledAt: issueStatus === "cancelled" ? closedAt : null,
    }).returning();
    const sessionId = randomUUID();
    const runStatus = input.runStatus ?? "succeeded";
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: runStatus,
      issueId: issue!.id,
      nativeIssueId: issue!.id,
      nativeSessionId: sessionId,
      finishedAt: ["queued", "running"].includes(runStatus) ? null : closedAt,
    }).returning();
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId: agent!.id,
      adapterType: "paperclip_runner",
      taskKey: issue!.id,
      sessionParamsJson: { sessionId },
      lastRunId: run!.id,
    });
    if (input.finalization) {
      await db.insert(nativeRunFinalizations).values({
        runId: run!.id,
        companyId,
        issueId: issue!.id,
        phase: input.finalization.phase,
        recoveryState: input.finalization.recoveryState ?? null,
      });
    }
    const scope = createHash("sha256").update(randomUUID()).digest("hex");
    const root = path.join(stateBase, scope);
    const current = path.join(root, "failover-backups", "current");
    await fs.mkdir(path.join(root, "control-plane"), { recursive: true });
    await fs.writeFile(
      path.join(root, "control-plane", "control-plane-state.json"),
      JSON.stringify({ identity: { runId: run!.id, normalizedSessionId: sessionId } }),
    );
    await fs.mkdir(path.join(current, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(current, "codex-home", "history.jsonl"), "x".repeat(64 * 1024));
    await fs.writeFile(path.join(current, "manifest.json"), "{}");
    const backupAt = new Date(now.getTime() - (input.backupAgeDays ?? 9) * DAY_MS);
    await fs.utimes(current, backupAt, backupAt);
    if (input.cleanupActive) await fs.writeFile(path.join(root, "cleanup-activation.json"), "{}");
    if (input.leaseStatus) {
      await db.insert(environmentLeases).values({
        companyId,
        status: input.leaseStatus,
        metadata: { nativeHarnessBackup: { sessionScopeSha256: scope } },
      });
    }
    return { companyId, agentId: agent!.id, issueId: issue!.id, sessionId, scope, root, current };
  }

  function service() {
    return nativeHarnessBackupExpirationService(db, {
      stateBase,
      closedForDays: 7,
      now,
      isSessionBusy: () => false,
    });
  }

  async function taskSessionCount(agentId: string) {
    return (await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId))).length;
  }

  it("expires the backup of a session whose issue closed before the window and clears its resume pointer", async () => {
    const session = await seedSession();
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 1, expired: 1, clearedTaskSessions: 1, failed: 0 });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(session.current)).toBe(false);
    expect(await exists(path.join(session.root, "control-plane", "control-plane-state.json"))).toBe(true);
    expect(await fs.readdir(path.join(session.root, "failover-backups"))).toEqual([]);
    expect(await taskSessionCount(session.agentId)).toBe(0);
  });

  it("expires sessions of cancelled issues", async () => {
    const session = await seedSession({ issueStatus: "cancelled" });
    expect(await service().tick()).toMatchObject({ expired: 1 });
    expect(await exists(session.current)).toBe(false);
  });

  it.each([
    ["issue_open", { issueStatus: "in_progress" }],
    ["recently_closed", { closedDaysAgo: 2 }],
    ["live_run", { runStatus: "running" }],
    ["pending_finalization", { finalization: { phase: "settling" } }],
    ["pending_finalization", { finalization: { phase: "committed", recoveryState: "resuming_session" } }],
    ["live_lease", { leaseStatus: "released" }],
    ["recent_backup", { backupAgeDays: 1 }],
    ["cleanup_active", { cleanupActive: true }],
  ] as const)("keeps the backup when %s", async (reason, input) => {
    const session = await seedSession(input);
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 0, expired: 0, failed: 0 });
    expect(result.skipped[reason]).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup when the session's control-plane state is too large to read", async () => {
    const session = await seedSession();
    const statePath = path.join(session.root, "control-plane", "control-plane-state.json");
    await fs.writeFile(statePath, `${await fs.readFile(statePath, "utf8")}${" ".repeat(5 * 1024 * 1024)}`);

    const result = await service().tick();

    expect(result.skipped.identity_unknown).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup of a session that is executing in this process", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      isSessionBusy: (scope) => scope === session.scope,
    }).tick();

    expect(result.skipped.session_active).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("settled finalizations and expired leases do not block expiry", async () => {
    const session = await seedSession({ finalization: { phase: "committed" }, leaseStatus: "expired" });
    expect(await service().tick()).toMatchObject({ expired: 1 });
    expect(await exists(session.current)).toBe(false);
  });

  it("reports candidates without deleting anything in dry run", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      dryRun: true,
      isSessionBusy: () => false,
    }).tick();

    expect(result).toMatchObject({ candidates: 1, expired: 0, clearedTaskSessions: 0 });
    expect(result.candidateBytes).toBeGreaterThan(0);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("continues across ticks when a batch is bounded", async () => {
    const sessions = [await seedSession(), await seedSession(), await seedSession()];
    const expiration = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      maxEntries: 2,
      isSessionBusy: () => false,
    });

    expect(await expiration.tick()).toMatchObject({ checked: 2, expired: 2, truncated: true });
    expect(await expiration.tick()).toMatchObject({ checked: 1, expired: 1, truncated: false });
    for (const session of sessions) expect(await exists(session.current)).toBe(false);
  });

  it("uses the configured clock for the closed window", async () => {
    const session = await seedSession({ closedDaysAgo: 8, backupAgeDays: 20 });
    const early = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now: new Date(now.getTime() - 2 * DAY_MS),
      isSessionBusy: () => false,
    });
    expect((await early.tick()).skipped.recently_closed).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await service().tick()).toMatchObject({ expired: 1 });
  });

  it("restores a backup whose expiry stopped before its final check", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.rename(session.current, retiring);

    await service().tick();

    expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("drops an unconfirmed retired backup once a newer backup exists", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.mkdir(path.join(retiring, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("finishes removing a backup left over from an interrupted expiry", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const leftover = path.join(session.root, "failover-backups", `.expired-${randomUUID()}`);
    await fs.mkdir(path.join(leftover, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(leftover)).toBe(false);
    expect(await exists(session.current)).toBe(true);
  });
});
