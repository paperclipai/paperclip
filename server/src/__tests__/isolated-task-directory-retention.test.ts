import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  executionWorkspaceRestorePoints,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import {
  expireIsolatedTaskDirectory,
  readTaskDirectoryRetention,
  sweepIsolatedTaskDirectories,
  TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING,
} from "../services/isolated-task-directory-retention.js";
import { markGitRestorePointExpired } from "../services/git-restore-point-storage.js";
import { gitRestorePointRetentionService } from "../services/git-restore-point-ledger.js";
import { getStorageService } from "../storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

async function age(target: string, at: Date) {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) for (const name of await fs.readdir(target)) await age(path.join(target, name), at);
  await (stat.isSymbolicLink() ? fs.lutimes(target, at, at) : fs.utimes(target, at, at));
}

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("isolated task directory retention", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  let outside: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("isolated-task-directory-retention-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-directory-retention-")));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside\n");
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await fs.rm(path.join(root, "home", "instances", "default", "isolated-workspaces"), { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  const settings = { dryRun: false, terminalDelayMs: 3 * DAY_MS, orphanGraceMs: 7 * DAY_MS };
  const restorePoints = (overrides: Partial<{ keyDurable: boolean }> = {}) => ({ storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, ...overrides });

  async function fixture(options: { closedDaysAgo?: number | null; mode?: string; status?: string } = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID();
    const closedDaysAgo = options.closedDaysAgo === undefined ? 4 : options.closedDaysAgo;
    await db.insert(companies).values({ id: companyId, name: "Task directory fixture", issuePrefix: `TD${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished task",
      status: closedDaysAgo === null ? "in_progress" : "done", completedAt: closedDaysAgo === null ? null : new Date(Date.now() - closedDaysAgo * DAY_MS) });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    await fs.writeFile(path.join(cwd, "report.md"), "final report\n");
    await fs.mkdir(path.join(cwd, "nested", "deeper"), { recursive: true });
    await fs.writeFile(path.join(cwd, "nested", "deeper", "data.json"), "{\"value\":1}\n");
    await fs.writeFile(path.join(cwd, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    await fs.symlink(outside, path.join(cwd, "outside-link"));
    await fs.writeFile(path.join(cwd, "package.json"), "{\"name\":\"fixture\"}\n");
    await fs.mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: options.mode ?? "isolated_workspace",
      strategyType: "project_primary", name: "Fixture", status: options.status ?? "active", providerType: "local_fs", cwd,
      closedAt: options.status === "archived" ? new Date(Date.now() - closedDaysAgo! * DAY_MS) : null,
      metadata: { source: "task_session", createdByRuntime: false } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const ledger = () => db.select().from(executionWorkspaceRestorePoints).where(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId));
    const service = (overrides: Parameters<typeof executionWorkspaceService>[1] = {}) => executionWorkspaceService(db, {
      taskDirectoryRetention: settings, gitRestorePoints: restorePoints(), ...overrides });
    const expire = async (overrides: Partial<Parameters<typeof expireIsolatedTaskDirectory>[2]> = {}) => expireIsolatedTaskDirectory(db, await row(), {
      dryRun: false, now: new Date(), notBefore: new Date(Date.now() - DAY_MS), restorePoint: { storage: getStorageService(), keyDurable: true }, ...overrides });
    const reopen = () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId,
      issue: { id: issueId, companyId, projectId: null }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    return { companyId, issueId, workspaceId, agentId, cwd, row, ledger, service, expire, reopen };
  }

  async function expectRestored(cwd: string) {
    expect(await fs.readFile(path.join(cwd, "report.md"), "utf8")).toBe("final report\n");
    expect(await fs.readFile(path.join(cwd, "nested", "deeper", "data.json"), "utf8")).toBe("{\"value\":1}\n");
    expect((await fs.stat(path.join(cwd, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(path.join(cwd, "outside-link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(cwd, "outside-link"))).toBe(outside);
    expect(await exists(path.join(cwd, "package.json"))).toBe(true);
    expect(await exists(path.join(cwd, "node_modules"))).toBe(false);
  }

  it("archives and removes a closed issue's task directory after the delay and restores it on reopen", async () => {
    const f = await fixture();
    const result = await f.service().sweepTerminalWorkspaces();
    expect(result).toMatchObject({ archived: 1 });
    expect(await exists(f.cwd)).toBe(false);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    const archived = await f.row();
    expect(archived).toMatchObject({ status: "archived", cleanupReason: "isolated task directory retention" });
    const state = readTaskDirectoryRetention(archived)!;
    expect(state).toMatchObject({ removed: true, restorePoint: { files: 4, excluded: 1 } });
    expect(await f.ledger()).toMatchObject([{ status: "active", objectKey: state.restorePoint.objectKey }]);

    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
    const reopened = await f.row();
    expect(reopened.status).toBe("active");
    expect(readTaskDirectoryRetention(reopened)).toBeNull();
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
  });

  it("restores a shared-workspace task directory through reopen", async () => {
    const f = await fixture({ mode: "shared_workspace" });
    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true });
    expect(await exists(f.cwd)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.executionWorkspaceId).toBe(f.workspaceId);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
  });

  it("keeps the directory until the terminal delay and registers that deadline", async () => {
    const f = await fixture({ closedDaysAgo: 1 });
    const service = f.service();
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const deadline = await service.nextTerminalWorkspaceSweepAt();
    expect(deadline).toBe(issue.completedAt!.getTime() + 3 * DAY_MS);
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps the directory while the issue is open", async () => {
    const f = await fixture({ closedDaysAgo: null });
    expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("does nothing when retention is not configured", async () => {
    const f = await fixture();
    await executionWorkspaceService(db, { gitRestorePoints: restorePoints() }).sweepTerminalWorkspaces();
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
  });

  type Consumer = (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>;
  const consumers: Array<[string, Consumer, string]> = [
    ["a live run", f => db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.issueId } }),
      "live_or_unresolved_consumer"],
    ["a live runtime service", f => db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, scopeType: "execution_workspace",
      serviceName: "web", status: "running", lifecycle: "shared", provider: "local_process", executionWorkspaceId: f.workspaceId, cwd: f.cwd }),
      "live_or_unresolved_consumer"],
    ["a reopen fence", f => db.update(executionWorkspaces).set({ metadata: { source: "task_session", reopenPendingConsumption: true } })
      .where(eq(executionWorkspaces.id, f.workspaceId)), "live_or_unresolved_consumer"],
    ["an unsettled finalization", async f => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        finishedAt: new Date(Date.now() - 4 * DAY_MS), nativeIssueId: f.issueId });
      await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed", leaseOwner: "native-finalizer:live" });
    }, "live_or_unresolved_consumer"],
    ["a live environment lease", f => db.insert(environmentLeases).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, status: "active" }),
      "live_or_unresolved_consumer"],
    ["an unresolved recovery action", f => db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", ownerAgentId: null, cause: "native_workspace_finalization_owner_unverified",
      fingerprint: randomUUID(), evidence: {}, nextAction: "Verify the owner." }), "live_or_unresolved_consumer"],
    ["an issue bound to another workspace", f => db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId)), "issue_not_bound"],
    ["a sibling live workspace in the directory", f => db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Sibling", status: "active", providerType: "local_fs", cwd: path.join(f.cwd, "nested") }),
      "live_or_unresolved_consumer"],
  ];

  it.each(consumers)("keeps the directory while %s exists", async (_label, add, reason) => {
    const f = await fixture();
    await add(f);
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: reason });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("removes the directory despite closed sibling rows at the same path", async () => {
    const f = await fixture();
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId, mode: "isolated_workspace",
      strategyType: "project_primary", name: "Old", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: f.cwd });
    expect(await f.expire()).toMatchObject({ expired: true });
  });

  it("refuses to remove without restore points or with a non-durable key", async () => {
    const f = await fixture();
    expect(await f.expire({ restorePoint: undefined })).toMatchObject({ expired: false, skipReason: "restore_points_disabled" });
    expect(await f.expire({ restorePoint: { storage: getStorageService(), keyDurable: false } }))
      .toMatchObject({ expired: false, skipReason: "restore_point_key_not_durable" });
    expect(await f.expire({ notBefore: new Date(Date.now() + DAY_MS) })).toMatchObject({ expired: false, skipReason: "not_due" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps files it cannot save", async () => {
    const f = await fixture();
    expect(await f.expire({ restorePoint: { storage: getStorageService(), keyDurable: true, limits: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 } } }))
      .toMatchObject({ expired: false, skipReason: "task_directory_too_many_files" });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("reports candidates in dry run without changing anything", async () => {
    const f = await fixture();
    const result = await f.service({ taskDirectoryRetention: { ...settings, dryRun: true }, gitRestorePoints: undefined }).sweepTerminalWorkspaces();
    expect(result).toMatchObject({ eligible: 1, archived: 0 });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("rolls back when the directory changes after it was saved", async () => {
    const f = await fixture();
    const result = await f.expire({ beforeDelete: async () => { await fs.writeFile(path.join(f.cwd, "late.txt"), "late work\n"); } });
    expect(result, JSON.stringify(result.failure)).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
    expect(await fs.readFile(path.join(f.cwd, "late.txt"), "utf8")).toBe("late work\n");
    const row = await f.row();
    expect(row.status).toBe("active");
    expect(readTaskDirectoryRetention(row)).toBeNull();
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
  });

  it("finishes an interrupted removal on the next sweep", async () => {
    const f = await fixture();
    await expect(f.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } }))
      .resolves.toMatchObject({ expired: false, skipReason: "simulated_crash" });
    expect(await exists(f.cwd)).toBe(true);
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: false });
    expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
    expect(await exists(f.cwd)).toBe(false);
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
  });

  it("never follows a task directory that is a symbolic link", async () => {
    const f = await fixture();
    const moved = path.join(root, `moved-${f.issueId}`);
    await fs.rename(f.cwd, moved);
    await fs.symlink(moved, f.cwd);
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "unsafe_task_directory" });
    expect(await fs.readFile(path.join(moved, "report.md"), "utf8")).toBe("final report\n");
    expect(await f.ledger()).toEqual([]);
    await fs.rm(f.cwd);
    await fs.rm(moved, { recursive: true });
  });

  it("reopens an empty directory with a warning when the saved files expired", async () => {
    const f = await fixture();
    expect(await f.expire()).toMatchObject({ expired: true });
    const [ledger] = await f.ledger();
    await markGitRestorePointExpired(db, ledger!);
    expect(readTaskDirectoryRetention(await f.row())?.restorePoint.expiredAt).toEqual(expect.any(String));
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true, warning: TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING });
    expect(await fs.readdir(f.cwd)).toEqual([]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.map(comment => comment.body)).toContain(TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING);
  });

  it("refuses to restore over a directory that diverged after removal", async () => {
    const f = await fixture();
    expect(await f.expire()).toMatchObject({ expired: true });
    await fs.mkdir(f.cwd);
    await fs.writeFile(path.join(f.cwd, "other.txt"), "unrelated\n");
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await fs.readFile(path.join(f.cwd, "other.txt"), "utf8")).toBe("unrelated\n");
    expect((await f.row()).status).toBe("archived");
  });

  it("saves and restores file names that contain a backslash", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "report\\final.txt"), "backslash name\n");
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(path.join(f.cwd, "report\\final.txt"), "utf8")).toBe("backslash name\n");
  });

  it("restores a deep path that fills the platform path length", async () => {
    const f = await fixture();
    let deep = f.cwd;
    while (deep.length < 1000) deep = path.join(deep, "d".repeat(Math.min(60, 1000 - deep.length)));
    await fs.mkdir(deep, { recursive: true });
    const file = path.join(deep, "z".repeat(Math.max(1, 1015 - deep.length)));
    await fs.writeFile(file, "deep\n");
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(file, "utf8")).toBe("deep\n");
  });

  it("keeps an expiry recorded while the directory was being removed, and records activity", async () => {
    const f = await fixture();
    const result = await f.expire({ beforeDelete: async () => {
      const [ledger] = await f.ledger();
      await markGitRestorePointExpired(db, ledger!);
    } });
    expect(result).toMatchObject({ expired: true });
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true, restorePoint: { expiredAt: expect.any(String) } });
    const actions = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, f.workspaceId));
    expect(actions.map(row => row.action).sort()).toEqual(["execution_workspace.task_directory_archived", "execution_workspace.task_directory_removed"]);
  });

  it("keeps a new restore point for the full retention even when the task closed long ago", async () => {
    const f = await fixture({ closedDaysAgo: 120 });
    expect(await f.expire()).toMatchObject({ expired: true });
    const retention = gitRestorePointRetentionService(db, { storage: getStorageService(), retentionDays: 90 });
    await retention.tick();
    expect(await f.ledger()).toMatchObject([{ status: "active" }]);
    expect(readTaskDirectoryRetention(await f.row())?.restorePoint.expiredAt).toBeUndefined();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
  });

  it("does not let skipped rows starve later rows of the per-sweep budget", async () => {
    const blocked = await fixture();
    execFileSync("mkfifo", [path.join(blocked.cwd, "pipe")]);
    const ready = await fixture();
    await db.update(executionWorkspaces).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(executionWorkspaces.id, blocked.workspaceId));
    const service = blocked.service({ taskDirectoryRetention: { ...settings, perSweep: 1 } });
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
    expect(await exists(ready.cwd)).toBe(true);
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
    expect(await exists(ready.cwd)).toBe(false);
    expect(await exists(blocked.cwd)).toBe(true);
  });

  describe("folder sweep", () => {
    const sweep = (overrides: Partial<Parameters<typeof sweepIsolatedTaskDirectories>[1]> = {}) => sweepIsolatedTaskDirectories(db, {
      dryRun: false, now: new Date(), orphanGraceMs: 7 * DAY_MS, terminalDelayMs: 3 * DAY_MS,
      restorePoint: { storage: getStorageService(), keyDurable: true }, ...overrides });

    async function orphan(options: { modifiedDaysAgo?: number } = {}) {
      const companyId = randomUUID(), issueId = randomUUID();
      const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
      await fs.writeFile(path.join(cwd, "left.txt"), "left behind\n");
      await fs.symlink(outside, path.join(cwd, "outside-link"));
      await age(cwd, new Date(Date.now() - (options.modifiedDaysAgo ?? 10) * DAY_MS));
      return { companyId, issueId, cwd };
    }

    it("removes an orphan whose issue is gone after the grace period", async () => {
      const o = await orphan();
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "removed", reason: null }]);
      expect(batch.results[0]!.reclaimedBytes).toBeGreaterThan(0);
      expect(await exists(o.cwd)).toBe(false);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    });

    it("keeps a recently modified orphan and schedules its deadline", async () => {
      const o = await orphan({ modifiedDaysAgo: 2 });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "skipped", reason: "recently_modified" }]);
      expect(batch.results[0]!.retryAt).toBeGreaterThan(Date.now() + 4 * DAY_MS);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("keeps an orphan in dry run", async () => {
      const o = await orphan();
      const batch = await sweep({ dryRun: true });
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "dry_run" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("keeps a folder that a live workspace points into", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Live", issuePrefix: `LV${o.companyId.slice(0, 6)}` });
      await db.insert(executionWorkspaces).values({ companyId: o.companyId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Live", status: "active", providerType: "local_fs", cwd: path.join(o.cwd, "sub") });
      const batch = await sweep();
      expect(batch.results).toEqual([]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("removes a folder whose archived row is unbound and whose issue closed long ago", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Archived", issuePrefix: `AR${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done", completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(executionWorkspaces).values({ companyId: o.companyId, sourceIssueId: o.issueId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Archived", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: o.cwd });
      expect((await sweep()).results).toMatchObject([{ outcome: "removed" }]);
      expect(await exists(o.cwd)).toBe(false);
    });

    it("keeps an orphan whose issue is still open", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Open", issuePrefix: `OP${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Open", status: "todo" });
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "issue_open" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("never follows an orphan that is a symbolic link", async () => {
      const companyId = randomUUID(), issueId = randomUUID();
      const parent = path.dirname(await materializeIsolatedTaskDirectory({ companyId, issueId }));
      await fs.rmdir(path.join(parent, issueId));
      await fs.symlink(outside, path.join(parent, issueId));
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "unsafe_task_directory" }]);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    });

    it("preserves an archived bound workspace's surviving folder before removing it, and reopen restores it", async () => {
      const f = await fixture({ status: "archived" });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: f.issueId, outcome: "preserved_and_removed", executionWorkspaceId: f.workspaceId }]);
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectRestored(f.cwd);
    });

    it("retries an orphan that a live run still uses", async () => {
      const o = await orphan();
      const agentId = randomUUID();
      await db.insert(companies).values({ id: o.companyId, name: "Busy", issuePrefix: `BS${o.companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId: o.companyId, name: "Busy agent" });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done", completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(heartbeatRuns).values({ companyId: o.companyId, agentId, status: "running", contextSnapshot: { issueId: o.issueId } });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ outcome: "skipped", reason: "live_run" }]);
      expect(batch.results[0]!.retryAt).toBeGreaterThan(Date.now());
      expect(await exists(o.cwd)).toBe(true);
    });

    it("finds a folder left by a later archive through workspace change hints", async () => {
      const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
      await service.sweepTerminalWorkspaces();
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();
      const f = await fixture({ status: "archived" });
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(true);
      service.terminalWorkspaceWorkSettled(new Set([`workspace:${f.workspaceId}`]));
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeLessThanOrEqual(Date.now());
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();
    });

    it("keeps overflowing folder deadlines discoverable through another walk", async () => {
      const folders = [await orphan({ modifiedDaysAgo: 1 }), await orphan({ modifiedDaysAgo: 1 })];
      let clock = Date.now();
      const service = executionWorkspaceService(db, { taskDirectoryRetention: { ...settings, trackedLimit: 1 },
        gitRestorePoints: restorePoints(), now: () => new Date(clock) });
      await service.sweepTerminalWorkspaces();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(true);
      const deadline = await service.nextTerminalWorkspaceSweepAt();
      expect(deadline).toBeGreaterThan(clock);
      clock = deadline! + 1000;
      await service.sweepTerminalWorkspaces();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(false);
    });

    it("returns to a parent's folder when its last open child closes", async () => {
      const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
      const f = await fixture({ status: "archived" });
      const childId = randomUUID();
      await db.insert(issues).values({ id: childId, companyId: f.companyId, parentId: f.issueId, title: "Open child", status: "todo" });
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(true);
      await db.update(issues).set({ status: "done", completedAt: new Date(Date.now() - 4 * DAY_MS) }).where(eq(issues.id, childId));
      service.terminalWorkspaceWorkSettled(new Set([`issue:${childId}`]));
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
    });

    it("keeps an orphan whose closed workspace still has a lease cleanup pending", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Lease", issuePrefix: `LS${o.companyId.slice(0, 6)}` });
      const [row] = await db.insert(executionWorkspaces).values({ companyId: o.companyId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Closed", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: o.cwd }).returning();
      await db.insert(environmentLeases).values({ companyId: o.companyId, executionWorkspaceId: row!.id, status: "pending_cleanup",
        releasedAt: new Date(Date.now() - 10 * DAY_MS) });
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "live_lease" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("bounds the work per sweep and continues from its cursor", async () => {
      const folders = [await orphan(), await orphan(), await orphan()];
      const first = await sweep({ limit: 2 });
      expect(first.results).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await sweep({ limit: 2, after: first.next });
      expect(second.results).toHaveLength(1);
      expect(second.next).toBeNull();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(false);
    });
  });
});
