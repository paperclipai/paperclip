import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaceRestorePoints, executionWorkspaces, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { ensurePersistedExecutionWorkspaceAvailable, realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { expireReconstructableGitWorkspace, gitWorkspaceLastActivityAt } from "../services/git-workspace-expiration.js";
import { getStorageService } from "../storage/index.js";
import { markGitRestorePointExpired } from "../services/git-restore-point-storage.js";
import { GIT_RESTORE_POINT_EXPIRED_WARNING, setMetadataReopenPendingConsumption } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const DAY_MS = 24 * 60 * 60 * 1000;

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("git restore point expiration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-restore-point-expiration-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restore-point-expiration-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const location = path.join(root, companyId), source = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "--initial-branch=main");
    await fs.writeFile(path.join(source, "marker.txt"), "commit A\n");
    await fs.writeFile(path.join(source, "remove-me.txt"), "tracked\n");
    await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n.env\n.claude/settings.local.json\n*.tsbuildinfo\nevidence/\n");
    git(source, "add", "."); git(source, "commit", "-m", "A");
    git(location, "clone", "--bare", source, remote); git(source, "remote", "add", "origin", remote);
    await db.insert(companies).values({ id: companyId, name: "Restore point fixture", issuePrefix: `RP${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished task", status: "done", completedAt: new Date(Date.now() - 4 * DAY_MS) });
    const repoUrl = pathToFileURL(remote).href;
    const baseCwd = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const base = { baseCwd, source: "task_session" as const, projectId: null, workspaceId: null, repoUrl, repoRef: "origin/main" };
    const workspace = await realizeExecutionWorkspace({ base, issue: { id: issueId, identifier: "RP-1", title: "Fixture" }, agent: { id: null, name: "Fixture", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "fixture-task", worktreeParentDir: path.join(location, "worktrees"), baseRef: "origin/main" } }, skipHostProvision: true });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Fixture", status: "active",
      providerType: "local_fs", cwd: workspace.cwd, providerRef: workspace.cwd, repoUrl, baseRef: "origin/main", branchName: workspace.branchName,
      metadata: { createdByRuntime: workspace.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: workspace.baseRefSha,
        isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const restorePoint = (overrides: Partial<{ notBefore: Date; keyDurable: boolean }> = {}) => ({
      storage: getStorageService(), notBefore: new Date(Date.now() - DAY_MS), keyDurable: true, ...overrides,
    });
    const expire = async (options: Partial<Parameters<typeof expireReconstructableGitWorkspace>[2]> = {}) =>
      expireReconstructableGitWorkspace(db, await row(), { dryRun: false, expireBase: false, now: new Date(), restorePoint: restorePoint(), ...options });
    const reopen = () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId,
      issue: { id: issueId, companyId, projectId: null }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    const ledger = () => db.select().from(executionWorkspaceRestorePoints).where(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId));
    const runtimeRestore = async () => ensurePersistedExecutionWorkspaceAvailable({ db, base,
      workspace: (await executionWorkspaceService(db).getStoredById(companyId, workspaceId))!,
      issue: { id: issueId, identifier: "RP-1", title: "Resumed task" },
      agent: { id: null, name: "Fixture", companyId }, skipHostProvision: true });
    return { companyId, issueId, workspaceId, cwd: workspace.cwd, baseCwd, row, restorePoint, expire, reopen, ledger, runtimeRestore };
  }

  async function makeUnsavedWork(cwd: string) {
    await fs.writeFile(path.join(cwd, "marker.txt"), "commit B (unpushed)\n");
    git(cwd, "commit", "-am", "B unpushed");
    const unpushed = git(cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(cwd, "marker.txt"), "staged edit\n");
    git(cwd, "add", "marker.txt");
    await fs.writeFile(path.join(cwd, "marker.txt"), "unstaged edit\n");
    await fs.rm(path.join(cwd, "remove-me.txt"));
    await fs.mkdir(path.join(cwd, "notes"));
    await fs.writeFile(path.join(cwd, "notes", "todo.md"), "untracked work\n");
    await fs.writeFile(path.join(cwd, ".env"), "TOKEN=old\n");
    return unpushed;
  }

  it("expires a worktree with unpushed and uncommitted work and restores it exactly on reopen", async () => {
    const f = await fixture();
    const unpushed = await makeUnsavedWork(f.cwd);
    expect(await f.expire()).toMatchObject({ candidate: true, expired: true, restorePoint: true, skipReason: null });
    expect(await exists(f.cwd)).toBe(false);
    const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
    expect(recipe).toMatchObject({ schema: "paperclip.git-cache-restoration.v2", commit: unpushed,
      restorePoint: { head: unpushed, headOnRemote: false, appliedAt: null } });
    expect(await f.ledger()).toMatchObject([{ status: "active", objectKey: recipe.restorePoint.objectKey }]);

    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await fs.readFile(path.join(f.cwd, "marker.txt"), "utf8")).toBe("unstaged edit\n");
    expect(git(f.cwd, "show", ":marker.txt")).toBe("staged edit");
    await expect(fs.access(path.join(f.cwd, "remove-me.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    await expect(fs.access(path.join(f.cwd, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    const restored = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
    expect(restored.restorePoint.appliedAt).toEqual(expect.any(String));
  });

  it("restores through the runtime path and never re-applies over later work", async () => {
    const f = await fixture();
    const unpushed = await makeUnsavedWork(f.cwd);
    expect(await f.expire()).toMatchObject({ expired: true });
    await db.update(executionWorkspaces).set({ status: "active", closedAt: null }).where(eq(executionWorkspaces.id, f.workspaceId));
    await f.runtimeRestore();
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    const applied = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
    expect(applied.restorePoint.appliedAt).toEqual(expect.any(String));
    await fs.writeFile(path.join(f.cwd, "notes", "todo.md"), "later work\n");
    await f.runtimeRestore();
    expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("later work\n");
  });

  it("imports history-only commits on reopen even when the base no longer has them", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "lost.txt"), "rewritten away\n");
    git(f.cwd, "add", "lost.txt");
    git(f.cwd, "commit", "-m", "rewritten away");
    const lost = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "reset", "-q", "--hard", "HEAD~1");
    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true });
    git(f.baseCwd, "reflog", "expire", "--expire=now", "--all");
    git(f.baseCwd, "gc", "-q", "--prune=now");
    expect(() => git(f.baseCwd, "cat-file", "-e", `${lost}^{commit}`)).toThrow();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.baseCwd, "cat-file", "-t", lost)).toBe("commit");
  });

  it("keeps a worktree whose draft commit message a restore point cannot save", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "marker.txt"), "staged edit\n");
    git(f.cwd, "add", "marker.txt");
    const gitDir = git(f.cwd, "rev-parse", "--absolute-git-dir");
    await fs.writeFile(path.join(gitDir, "COMMIT_EDITMSG"), "Draft message from an aborted commit\n");
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "uncommitted_git_message" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("marks a restore point for cleanup when its upload fails", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    const storage = getStorageService();
    const failing = { ...storage, putFile: async () => { throw new Error("storage unavailable"); } };
    expect(await f.expire({ restorePoint: { ...f.restorePoint(), storage: failing as typeof storage } }))
      .toMatchObject({ expired: false });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
    expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
  });

  it("does not expire unsaved work before the restore point delay", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    expect(await f.expire({ restorePoint: f.restorePoint({ notBefore: new Date(Date.now() + DAY_MS) }) }))
      .toMatchObject({ expired: false, skipReason: "restore_point_not_due" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps today's behavior when restore points are disabled", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    expect(await f.expire({ restorePoint: undefined })).toMatchObject({ expired: false, skipReason: "dirty_or_untracked_files" });
    expect(await exists(f.cwd)).toBe(true);
  });

  it("refuses to capture when the encryption key is not durable", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    expect(await f.expire({ restorePoint: f.restorePoint({ keyDurable: false }) }))
      .toMatchObject({ expired: false, skipReason: "restore_point_key_not_durable" });
    expect(await exists(f.cwd)).toBe(true);
  });

  it("keeps the worktree and drops the restore point when contents change after capture", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    const result = await f.expire({ beforeDelete: async () => { await fs.writeFile(path.join(f.cwd, "notes", "todo.md"), "changed after capture\n"); } });
    expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("changed after capture\n");
    const after = await f.row();
    expect(after.status).toBe("active");
    expect(after.metadata?.gitCacheRestoration).toMatchObject({ schema: "paperclip.git-cache-restoration.v1" });
    expect((after.metadata?.gitCacheRestoration as Record<string, unknown>).restorePoint).toBeUndefined();
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
  });

  it("fails closed when the stored restore point is missing", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    expect(await f.expire()).toMatchObject({ expired: true });
    const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
    await getStorageService().deleteObject(f.companyId, recipe.restorePoint.objectKey);
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    const failed = await f.row();
    expect(failed.status).toBe("archived");
    expect(failed.metadata?.gitCacheRestoration).toMatchObject({ restorePoint: { objectKey: recipe.restorePoint.objectKey, appliedAt: null } });
    await expect(fs.access(path.join(f.cwd, "notes", "todo.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
  });

  it("reopens a workspace whose restore point expired as a fresh workspace with a warning", async () => {
    const f = await fixture();
    const unpushed = await makeUnsavedWork(f.cwd);
    expect(await f.expire()).toMatchObject({ expired: true });
    const [ledgerRow] = await f.ledger();
    await markGitRestorePointExpired(db, ledgerRow!);
    await getStorageService().deleteObject(f.companyId, ledgerRow!.objectKey);
    const branch = (await f.row()).branchName!;
    git(f.baseCwd, "worktree", "prune");
    git(f.baseCwd, "branch", "-D", branch);
    git(f.baseCwd, "reflog", "expire", "--expire=now", "--all");
    git(f.baseCwd, "gc", "-q", "--prune=now");
    expect(() => git(f.baseCwd, "cat-file", "-e", `${unpushed}^{commit}`)).toThrow();
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ restorePoint: { expiredAt: expect.any(String) } });
    await fs.writeFile(f.cwd, "blocks the worktree\n");
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ restorePoint: { expiredAt: expect.any(String) } });
    await fs.rm(f.cwd);
    const reopened = await f.reopen();
    expect(reopened).toMatchObject({ ok: true, reopened: true, warning: GIT_RESTORE_POINT_EXPIRED_WARNING });
    expect(await exists(f.cwd)).toBe(true);
    expect(git(f.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(git(f.cwd, "rev-parse", "HEAD")).not.toBe(unpushed);
    expect(git(f.cwd, "status", "--porcelain")).toBe("");
    await expect(fs.access(path.join(f.cwd, "notes", "todo.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.filter(comment => comment.body === GIT_RESTORE_POINT_EXPIRED_WARNING)).toMatchObject([{ authorType: "system" }]);
  });

  describe("idle open issues", () => {
    async function openIdle(f: Awaited<ReturnType<typeof fixture>>, idleDays: number) {
      await db.update(issues).set({ status: "in_progress", completedAt: null, updatedAt: new Date(Date.now() - idleDays * DAY_MS) })
        .where(eq(issues.id, f.issueId));
    }
    const idle = (now = Date.now()) => ({ idleCutoff: new Date(now - 7 * DAY_MS) });

    it("expires an open issue's idle worktree with a restore point and restores it on reopen", async () => {
      const f = await fixture();
      const unpushed = await makeUnsavedWork(f.cwd);
      await openIdle(f, 8);
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await f.expire(idle())).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      expect(await exists(f.cwd)).toBe(false);
      expect((await f.row()).status).toBe("archived");
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    });

    it("lets the workspace reaper expire idle open issues at their idle deadline", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      const updatedAt = new Date(Date.now() - 3 * DAY_MS);
      await db.update(issues).set({ status: "in_progress", completedAt: null, updatedAt }).where(eq(issues.id, f.issueId));
      const worker = (now: number) => executionWorkspaceService(db, { gitCacheExpirationEnabled: true, now: () => new Date(now),
        gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, idleMs: 7 * DAY_MS } });
      const early = worker(Date.now());
      expect(await early.sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await early.nextTerminalWorkspaceSweepAt()).toBe(updatedAt.getTime() + 7 * DAY_MS);
      expect(await exists(f.cwd)).toBe(true);
      const due = worker(updatedAt.getTime() + 7 * DAY_MS + 60_000);
      expect(await due.sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
    });

    it("lets the workspace reaper finish an interrupted idle expiration while the issue stays open", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await openIdle(f, 8);
      expect(await f.expire({ ...idle(), beforeDelete: async () => { throw new Error("interrupted_fixture"); } }))
        .toMatchObject({ expired: false });
      expect(await f.row()).toMatchObject({ status: "archived", metadata: { gitCacheExpiration: { completed: false } } });
      expect(await exists(f.cwd)).toBe(true);
      const worker = executionWorkspaceService(db, { gitCacheExpirationEnabled: true,
        gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, idleMs: 7 * DAY_MS } });
      expect(await worker.sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    });

    it("counts activity on another issue bound to the workspace", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await openIdle(f, 8);
      const other = randomUUID();
      await db.insert(issues).values({ id: other, companyId: f.companyId, title: "Unrelated issue sharing the workspace", status: "todo",
        executionWorkspaceId: f.workspaceId, updatedAt: new Date(Date.now() - DAY_MS) });
      expect((await gitWorkspaceLastActivityAt(db, await f.row()))!.getTime()).toBeGreaterThan(Date.now() - 2 * DAY_MS);
      expect(await f.expire(idle())).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("never expires open issues when idle expiry is off", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await openIdle(f, 30);
      const worker = executionWorkspaceService(db, { gitCacheExpirationEnabled: true,
        gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, idleMs: null } });
      expect(await worker.sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await worker.nextTerminalWorkspaceSweepAt()).toBeNull();
      expect(await exists(f.cwd)).toBe(true);
    });

    it("keeps an open issue's worktree that saw activity inside the idle window", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await openIdle(f, 3);
      expect(await f.expire(idle())).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("keeps an open issue's worktree whose latest run finished inside the idle window", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await openIdle(f, 8);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Worker", adapterType: "process" });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId: f.issueId, status: "succeeded",
        createdAt: new Date(Date.now() - 2 * DAY_MS), startedAt: new Date(Date.now() - 2 * DAY_MS), finishedAt: new Date(Date.now() - 2 * DAY_MS) });
      expect(await gitWorkspaceLastActivityAt(db, await f.row())).toEqual(expect.any(Date));
      expect(await f.expire(idle())).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
    });
  });

  describe("closed source issue with open descendants", () => {
    async function child(f: Awaited<ReturnType<typeof fixture>>, values: Partial<typeof issues.$inferInsert> = {}) {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId: f.companyId, parentId: f.issueId, title: "Follow-up", status: "blocked", ...values });
      return id;
    }
    async function ownWorkspace(f: Awaited<ReturnType<typeof fixture>>, sourceIssueId: string) {
      const id = randomUUID();
      await db.insert(executionWorkspaces).values({ id, companyId: f.companyId, sourceIssueId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: "Child workspace", status: "active", providerType: "local_fs", cwd: path.join(root, "child-workspaces", id), providerRef: path.join(root, "child-workspaces", id) });
      await db.update(issues).set({ executionWorkspaceId: id, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, sourceIssueId));
      return id;
    }
    const worker = (now = Date.now()) => executionWorkspaceService(db, { gitCacheExpirationEnabled: true, now: () => new Date(now),
      gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, idleMs: 7 * DAY_MS } });

    it("expires the closed issue's worktree while open children work in their own workspaces", async () => {
      const f = await fixture();
      const unpushed = await makeUnsavedWork(f.cwd);
      const blocked = await child(f, { status: "blocked" });
      await ownWorkspace(f, blocked);
      const reviewing = await child(f, { status: "in_review" });
      await ownWorkspace(f, reviewing);
      const grandchild = await child(f, { parentId: reviewing, status: "in_progress" });
      await ownWorkspace(f, grandchild);
      await child(f, { status: "todo" });
      expect(await f.expire()).toMatchObject({ candidate: true, expired: true, restorePoint: true, skipReason: null });
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    });

    it("lets the workspace reaper expire it, timed from the issues that use the workspace", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      const open = await child(f, { status: "in_progress", updatedAt: new Date() });
      await ownWorkspace(f, open);
      const closed = await child(f, { status: "done", completedAt: new Date(Date.now() - 60_000) });
      await ownWorkspace(f, closed);
      expect(await worker().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
      expect((await f.row()).status).toBe("archived");
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
    });

    it("times the restore point from the issues that use the workspace once every child is closed", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      const closed = await child(f, { status: "done", completedAt: new Date(Date.now() - 60_000) });
      await ownWorkspace(f, closed);
      expect(await worker().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
    });

    it("waits for the terminal delay of a recently closed child that used the workspace", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await child(f, { status: "in_progress" }).then(id => ownWorkspace(f, id));
      const closedAt = new Date(Date.now() - DAY_MS);
      await child(f, { status: "done", completedAt: closedAt, executionWorkspaceId: f.workspaceId });
      const early = worker();
      expect(await early.sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
      expect(await exists(f.cwd)).toBe(true);
      expect(await worker(closedAt.getTime() + 3 * DAY_MS + 60_000).sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
    });

    it("never compacts a closed issue's worktree while children are open", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await db.update(executionWorkspaces).set({ providerType: "git_worktree" }).where(eq(executionWorkspaces.id, f.workspaceId));
      await db.update(issues).set({ completedAt: new Date(Date.now() - 2 * DAY_MS) }).where(eq(issues.id, f.issueId));
      await fs.mkdir(path.join(f.cwd, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(f.cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
      await child(f, { status: "in_progress" }).then(id => ownWorkspace(f, id));
      for (const reaper of [executionWorkspaceService(db, { workspaceCompactionDelayMs: 0 }),
        executionWorkspaceService(db, { workspaceCompactionDelayMs: 0, gitCacheExpirationEnabled: true,
          gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true } })]) {
        expect(await reaper.sweepTerminalWorkspaces()).toMatchObject({ archived: 0, compacted: 0 });
        expect(await exists(path.join(f.cwd, "node_modules", "pkg", "index.js"))).toBe(true);
      }
    });

    it("keeps today's reopen fence handling while a reopen is pending", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await child(f, { status: "in_progress" }).then(id => ownWorkspace(f, id));
      await db.update(executionWorkspaces).set({ metadata: setMetadataReopenPendingConsumption((await f.row()).metadata, new Date()) })
        .where(eq(executionWorkspaces.id, f.workspaceId));
      expect(await worker().sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
      expect(await exists(f.cwd)).toBe(true);
      expect((await f.row()).metadata?.reopenPendingConsumption).toBeUndefined();
    });

    it("keeps the worktree while an open child is bound to it", async () => {
      const f = await fixture();
      await makeUnsavedWork(f.cwd);
      await child(f, { status: "blocked", executionWorkspaceId: f.workspaceId, executionWorkspacePreference: "reuse_existing" });
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await worker().sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("keeps the worktree while an open grandchild is bound to it under a child with its own workspace", async () => {
      const f = await fixture();
      const middle = await child(f, { status: "in_review" });
      await ownWorkspace(f, middle);
      await child(f, { parentId: middle, status: "todo", executionWorkspaceId: f.workspaceId });
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("keeps the worktree for a child created later that inherits it with reuse_existing", async () => {
      const f = await fixture();
      const created = await issueService(db).create(f.companyId, { parentId: f.issueId, title: "Inherited follow-up", status: "todo" });
      expect(created).toMatchObject({ executionWorkspaceId: f.workspaceId, executionWorkspacePreference: "reuse_existing" });
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await worker().sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("keeps the worktree while an open child selects it as its existing workspace", async () => {
      const f = await fixture();
      const selection = { kind: "existing" as const, workspaceId: f.workspaceId };
      const selecting = await child(f, { status: "todo", workspaceSelection: { version: 1, selection, source: "explicit" } });
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      await db.update(issues).set({ workspaceSelection: null, workspacePendingSelection: { version: 1, requestKey: "fixture",
        expectedBindingRevision: 0, intent: { version: 1, selection, source: "explicit" } } }).where(eq(issues.id, selecting));
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      await db.update(issues).set({ workspacePendingSelection: null }).where(eq(issues.id, selecting));
      expect(await f.expire()).toMatchObject({ expired: true });
    });

    it("keeps the worktree while a child run referencing it is live", async () => {
      const f = await fixture();
      const running = await child(f, { status: "in_progress" });
      await ownWorkspace(f, running);
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Worker", adapterType: "process" });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "running", startedAt: new Date(),
        contextSnapshot: { issueId: running, executionWorkspaceId: f.workspaceId } }).returning();
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
      expect(await f.expire()).toMatchObject({ expired: true });
    });

    it("keeps the worktree while the closed issue was closed inside the terminal delay", async () => {
      const f = await fixture();
      await db.update(issues).set({ completedAt: new Date(Date.now() - 60_000) }).where(eq(issues.id, f.issueId));
      await child(f, { status: "in_progress" }).then(id => ownWorkspace(f, id));
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" });
      expect(await exists(f.cwd)).toBe(true);
    });

    it("restores the saved state when an open child later binds to the expired workspace", async () => {
      const f = await fixture();
      const unpushed = await makeUnsavedWork(f.cwd);
      const follower = await child(f, { status: "in_progress" });
      expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true });
      await db.update(issues).set({ executionWorkspaceId: f.workspaceId, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, follower));
      const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspaceId,
        issue: { id: follower, companyId: f.companyId, projectId: null }, actor: { actorType: "user", agentId: null },
        authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
      expect(reopened).toMatchObject({ ok: true, reopened: true });
      expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      expect(await fs.readFile(path.join(f.cwd, "marker.txt"), "utf8")).toBe("unstaged edit\n");
      expect(git(f.cwd, "show", ":marker.txt")).toBe("staged edit");
      expect(await fs.readFile(path.join(f.cwd, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    });
  });

  it("expires a worktree whose only extra files are ignored, and restores them on reopen", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.cwd, "ui"), { recursive: true });
    await fs.writeFile(path.join(f.cwd, "ui", "tsconfig.tsbuildinfo"), "{\"version\":\"5\"}\n");
    await fs.mkdir(path.join(f.cwd, "evidence"));
    await fs.writeFile(path.join(f.cwd, "evidence", "run.log"), "agent evidence\n");
    await fs.mkdir(path.join(f.cwd, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(f.cwd, "node_modules", "pkg", "index.js"), "regenerable\n");
    expect(git(f.cwd, "status", "--porcelain")).toBe("");
    expect(await f.expire({ restorePoint: undefined })).toMatchObject({ expired: false, skipReason: "unique_ignored_files" });
    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
    expect(await exists(f.cwd)).toBe(false);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(path.join(f.cwd, "ui", "tsconfig.tsbuildinfo"), "utf8")).toBe("{\"version\":\"5\"}\n");
    expect(await fs.readFile(path.join(f.cwd, "evidence", "run.log"), "utf8")).toBe("agent evidence\n");
    expect(await exists(path.join(f.cwd, "node_modules", "pkg", "index.js"))).toBe(false);
  });

  it("rolls back when an ignored file changes after capture", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.cwd, "evidence"));
    await fs.writeFile(path.join(f.cwd, "evidence", "run.log"), "agent evidence\n");
    const result = await f.expire({ beforeDelete: async () => {
      await fs.writeFile(path.join(f.cwd, "evidence", "run.log"), "written after capture\n");
    } });
    expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
    expect(await fs.readFile(path.join(f.cwd, "evidence", "run.log"), "utf8")).toBe("written after capture\n");
  });

  it("reports a restore point candidate in dry run without storing anything", async () => {
    const f = await fixture();
    await makeUnsavedWork(f.cwd);
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, expired: false, restorePoint: true, skipReason: null });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
    expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
  });

  it("still expires a fully reproducible worktree without a restore point", async () => {
    const f = await fixture();
    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: false });
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ schema: "paperclip.git-cache-restoration.v1" });
    expect(await f.ledger()).toEqual([]);
  });
});
