import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, projects, projectWorkspaces, issues, executionWorkspaces, agents, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, workspaceRuntimeServices, executionWorkspaceRestorePoints, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { markGitRestorePointExpired } from "../services/git-restore-point-storage.js";
import { GIT_RESTORE_POINT_EXPIRED_WARNING } from "../services/execution-workspaces.js";
import { getStorageService } from "../storage/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.js";
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace, ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { prepareProjectRepositoryWorkspaces, mergeExecutionWorkspaceMetadataForPersistence } from "../services/heartbeat/workspaces.js";
import { describeGitExpirationFailure, expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import { nestedWorktreeBranchPrefix, restoreNestedRepositoryWorktree, withNestedRepositoryBaseLock } from "../services/nested-repository-worktrees.js";
import * as activityLog from "../services/activity-log.js";
import { readGitCacheRestoration } from "../services/git-workspace-restoration.js";
import { assertReproducibleManagedCheckout, gitCacheExpirationLockLocations, readGitCacheExpiration } from "../services/git-workspace-restoration.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_GIT_EXPIRATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("reconstructable Git expiration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("git-cache-expiration-");
    db = createDb(external ?? database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database?.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(managed = false, nested = false, withProject = managed) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const location = path.join(root, companyId), source = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "--initial-branch=main");
    await fs.writeFile(path.join(source, "marker.txt"), "commit A\n");
    await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\nprivate-notes/\n.claude/settings.local.json\n");
    git(source, "add", "."); git(source, "commit", "-m", "A");
    const commitA = git(source, "rev-parse", "HEAD");
    git(location, "clone", "--bare", source, remote); git(source, "remote", "add", "origin", remote);
    await db.insert(companies).values({ id: companyId, name: "Git expiration fixture", issuePrefix: `GC${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished task", status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) });
    const repoUrl = pathToFileURL(remote).href;
    const projectId = withProject ? randomUUID() : null;
    if (projectId) await db.insert(projects).values({ id: projectId, companyId, name: "Fixture project" });
    const baseCwd = managed
      ? (await materializeManagedProjectWorkspace(resolveManagedProjectWorkspaceDir({ companyId, projectId: projectId!, repoName: "remote" }), { repoUrl })).cwd
      : await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const base = { baseCwd, source: "task_session" as const, projectId: null, workspaceId: null, repoUrl, repoRef: "origin/main" };
    const workspace = await realizeExecutionWorkspace({ base, issue: { id: issueId, identifier: "GC-1", title: "Fixture" }, agent: { id: null, name: "Fixture", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "fixture-task", worktreeParentDir: nested ? path.join(baseCwd, ".paperclip", "worktrees") : path.join(location, "worktrees"), baseRef: "origin/main" } }, skipHostProvision: true });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Fixture", status: "active",
      providerType: "local_fs", cwd: workspace.cwd, providerRef: workspace.cwd, repoUrl, baseRef: "origin/main", branchName: workspace.branchName,
      metadata: { createdByRuntime: workspace.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: workspace.baseRefSha,
        ...(managed ? {} : { isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } }) } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const expire = async (options: Partial<Parameters<typeof expireReconstructableGitWorkspace>[2]> = {}) =>
      expireReconstructableGitWorkspace(db, await row(), { dryRun: false, expireBase: true, now: new Date(), ...options });
    const reopen = (company = companyId) => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId,
      issue: { id: issueId, companyId: company, projectId: null }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    const advance = async () => {
      await fs.writeFile(path.join(source, "marker.txt"), "commit B\n"); git(source, "add", "."); git(source, "commit", "-m", "B"); git(source, "push", "origin", "main");
      return git(source, "rev-parse", "HEAD");
    };
    return { companyId, projectId, issueId, workspaceId, cwd: workspace.cwd, baseCwd, base, remote, source, commitA, row, expire, reopen, advance };
  }

  it("expires through the lifecycle worker and restores the recorded commit after upstream advances", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.cwd, "node_modules")); await fs.writeFile(path.join(f.cwd, "node_modules", "cache"), "regenerable");
    await fs.symlink("cache", path.join(f.cwd, "node_modules", "cache-link"));
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, expired: false, reclaimedBytes: 0, skipReason: null });
    expect(await exists(f.cwd)).toBe(true); expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
    await f.advance();
    const outcome = await executionWorkspaceService(db, { gitCacheExpirationEnabled: true, gitBaseExpirationEnabled: true }).sweepTerminalWorkspaces();
    expect(outcome.archived).toBe(1);
    expect(await exists(f.cwd)).toBe(false); expect(await exists(f.baseCwd)).toBe(false);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ commit: f.commitA });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    expect(await fs.readFile(path.join(f.cwd, "marker.txt"), "utf8")).toBe("commit A\n");
    // The next heartbeat uses this runtime path before handing files to the agent.
    await ensurePersistedExecutionWorkspaceAvailable({ db, base: f.base,
      workspace: (await executionWorkspaceService(db).getStoredById(f.companyId, f.workspaceId))!,
      issue: { id: f.issueId, identifier: "GC-1", title: "Resumed task" },
      agent: { id: null, name: "Fixture", companyId: f.companyId }, skipHostProvision: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    await fs.writeFile(path.join(f.cwd, "continued.txt"), "continued\n"); git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "Continued");
    const continued = git(f.cwd, "rev-parse", "HEAD");
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: false });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(continued);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ commit: f.commitA, restoredAt: expect.any(String) });
    git(f.baseCwd, "worktree", "remove", f.cwd);
    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(continued);
  });

  it("expires a worktree after an ordinary fetch and restores its older recorded commit", async () => {
    const f = await fixture();
    await f.advance();
    git(f.cwd, "fetch", "origin", "main");
    expect(await f.expire()).toMatchObject({ expired: true, baseExpired: true });
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("preserves the contents checkpoint through normal runtime metadata persistence", async () => {
    const f = await fixture();
    const settingsPath = path.join(f.cwd, ".claude/settings.local.json");
    await fs.mkdir(path.dirname(settingsPath));
    await fs.writeFile(settingsPath, "original settings\n");
    expect((await f.expire({ expireBase: false })).expired).toBe(true);
    const service = executionWorkspaceService(db);
    const stored = (await service.getStoredById(f.companyId, f.workspaceId))!;
    const input = { db, base: f.base, workspace: stored,
      issue: { id: f.issueId, identifier: "GC-1", title: "Resumed task" },
      agent: { id: null, name: "Fixture", companyId: f.companyId }, skipHostProvision: true };
    const restored = (await ensurePersistedExecutionWorkspaceAvailable(input))!;
    await service.update(f.workspaceId, { metadata: mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata: stored.metadata, source: restored.source, createdByRuntime: restored.branchCreatedByRuntime,
      strategyType: restored.strategy, configSnapshot: null, shouldReuseExisting: true,
      baseRef: restored.repoRef, baseRefSha: restored.baseRefSha,
    }) });
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ contentsRestoredAt: expect.any(String) });
    await fs.writeFile(settingsPath, "later task settings\n");
    await ensurePersistedExecutionWorkspaceAvailable({ ...input, workspace: (await service.getStoredById(f.companyId, f.workspaceId))! });
    expect(await fs.readFile(settingsPath, "utf8")).toBe("later task settings\n");
  });

  async function nestedFixture(managed = true, shared = false) {
    const f = await fixture(managed, !managed, true);
    const nestedSource = path.join(path.dirname(f.source), "nested-author");
    const nestedRemote = path.join(path.dirname(f.source), "nested.git");
    await fs.mkdir(nestedSource);
    git(nestedSource, "init", "--initial-branch=main");
    await fs.writeFile(path.join(nestedSource, "nested.txt"), "nested A\n");
    await fs.writeFile(path.join(nestedSource, ".gitignore"), ".claude/settings.local.json\n");
    git(nestedSource, "add", "."); git(nestedSource, "commit", "-m", "Nested A");
    const nestedA = git(nestedSource, "rev-parse", "HEAD");
    git(path.dirname(nestedSource), "clone", "--bare", nestedSource, nestedRemote);
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId!,
      name: "Nested repository", repoUrl: pathToFileURL(nestedRemote).href, repoRef: "main" }).returning();
    const preparation = { cwd: f.cwd, anchorRepoUrl: f.base.repoUrl, workspaces: [source!], resolveGitAuth: async () => null,
      ...(shared ? { sharedBase: { companyId: f.companyId, projectId: f.projectId! } } : {}) };
    const [nested] = await prepareProjectRepositoryWorkspaces(preparation);
    const settings = Buffer.from('{"permissions":{"allow":["Read(/user/path)"]},"env":{"LOCAL_SETTING":"preserve-me"}}\n');
    const settingsPath = path.join(f.cwd, ".claude/settings.local.json");
    await fs.mkdir(path.dirname(settingsPath));
    await fs.writeFile(settingsPath, settings, { mode: 0o600 });
    const nestedSettingsPath = path.join(nested!.cwd, ".claude/settings.local.json");
    await fs.mkdir(path.dirname(nestedSettingsPath));
    await fs.writeFile(nestedSettingsPath, settings, { mode: 0o640 });
    return { ...f, nestedSource, nestedRemote, nestedA, preparation, nested: nested!, settings, settingsPath, nestedSettingsPath,
      sharedBase: resolveManagedProjectWorkspaceDir({ companyId: f.companyId, projectId: f.projectId!, repoName: "nested" }) };
  }

  it("expires a nested workspace and its unused private base with the generated ignore entry", async () => {
    const f = await nestedFixture(false);
    await f.advance();
    await fs.writeFile(path.join(f.nestedSource, "nested.txt"), "nested B\n");
    git(f.nestedSource, "add", "."); git(f.nestedSource, "commit", "-m", "Nested B");
    git(f.nestedSource, "push", f.nestedRemote, "main");
    const result = await f.expire();
    expect(result).toMatchObject({ expired: true, baseExpired: true, skipReason: null });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await exists(f.cwd)).toBe(false);
    expect(await exists(f.baseCwd)).toBe(false);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
    expect((await fs.stat(f.settingsPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(f.nestedSettingsPath)).toEqual(f.settings);
    expect((await fs.stat(f.nestedSettingsPath)).mode & 0o777).toBe(0o640);
    await fs.writeFile(path.join(f.nested.cwd, "continued.txt"), "continued after base restoration\n");
    git(f.nested.cwd, "add", "."); git(f.nested.cwd, "commit", "-m", "Continued after base restoration");
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).not.toBe(f.nestedA);
  });

  describe("restore points for nested checkouts", () => {
    const restorePoint = () => ({ storage: getStorageService(), notBefore: new Date(Date.now() - 24 * 3_600_000), keyDurable: true });
    const ledger = (workspaceId: string) => db.select().from(executionWorkspaceRestorePoints)
      .where(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId));
    async function unpushedNestedWork(nestedCwd: string) {
      await fs.writeFile(path.join(nestedCwd, "nested.txt"), "nested B (unpushed)\n");
      git(nestedCwd, "commit", "-am", "Nested B unpushed");
      const unpushed = git(nestedCwd, "rev-parse", "HEAD");
      await fs.writeFile(path.join(nestedCwd, "draft.md"), "nested untracked work\n");
      return unpushed;
    }

    it("expires a workspace whose nested checkout has unsaved work and restores the checkout exactly", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      const unpushed = await unpushedNestedWork(f.nested.cwd);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "dirty_or_untracked_files" });
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint() });
      expect(result).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
      expect(recipe.schema).toBe("paperclip.git-cache-restoration.v2");
      expect(recipe.restorePoint).toBeUndefined();
      expect(recipe.contents.checkouts[0].restorePoint).toMatchObject({ head: unpushed, headOnRemote: false });
      expect(await ledger(f.workspaceId)).toMatchObject([{ status: "active", checkoutName: recipe.contents.checkouts[0].name }]);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      expect(await fs.readFile(path.join(f.nested.cwd, "draft.md"), "utf8")).toBe("nested untracked work\n");
      expect(await fs.readFile(f.nestedSettingsPath)).toEqual(f.settings);
      vi.unstubAllEnvs();
    });

    it("reopens with a fresh workspace and a warning when a nested checkout's restore point expired", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true });
      const [row] = await ledger(f.workspaceId);
      await markGitRestorePointExpired(db, row!);
      const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
      expect(recipe.contents.checkouts[0].restorePoint.expiredAt).toEqual(expect.any(String));
      await fs.rm(f.nested.cwd, { recursive: true, force: true });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true, warning: GIT_RESTORE_POINT_EXPIRED_WARNING });
      expect(await exists(f.cwd)).toBe(true);
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      expect(await exists(path.join(f.nested.cwd, "draft.md"))).toBe(false);
      expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it("expires and restores a nested checkout that only has an unpushed commit", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await fs.writeFile(path.join(f.nested.cwd, "nested.txt"), "nested B (unpushed)\n");
      git(f.nested.cwd, "commit", "-am", "Nested B unpushed");
      const unpushed = git(f.nested.cwd, "rev-parse", "HEAD");
      expect(await exists(path.join(f.nested.cwd, ".git", "COMMIT_EDITMSG"))).toBe(true);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      vi.unstubAllEnvs();
    });

    it("keeps a workspace whose nested checkout holds unpushed history only in another branch's reflog", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      const tree = git(f.nested.cwd, "rev-parse", "HEAD^{tree}");
      const orphan = execFileSync("git", ["commit-tree", tree, "-p", "HEAD", "-m", "Only in a reflog"],
        { cwd: f.nested.cwd, env: gitEnv, encoding: "utf8" }).trim();
      git(f.nested.cwd, "update-ref", "--create-reflog", "refs/heads/side", orphan);
      git(f.nested.cwd, "update-ref", "refs/heads/side", f.nestedA);
      await fs.writeFile(path.join(f.nested.cwd, "draft.md"), "untracked\n");
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() }))
        .toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout_branches" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("rolls back when new history appears after capture without changing files", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint(), beforeDelete: async () => {
        git(f.nested.cwd, "commit", "--allow-empty", "-q", "-m", "Made after capture");
        git(f.nested.cwd, "reset", "-q", "--soft", "HEAD~1");
      } });
      expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("rolls back when the main worktree gains history after capture without changing files", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await fs.writeFile(path.join(f.cwd, "draft.md"), "untracked main work\n");
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint(), beforeDelete: async () => {
        git(f.cwd, "commit", "--allow-empty", "-q", "-m", "Made after capture");
        git(f.cwd, "reset", "-q", "--soft", "HEAD~1");
      } });
      expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    it.each([
      ["a named pipe", async (file: string) => { execFileSync("mkfifo", [file]); }],
      ["an oversized file", async (file: string) => { await fs.writeFile(file, "x".repeat(65 * 1024)); }],
      ["a symlink", async (file: string) => { await fs.symlink("/dev/zero", file); }],
    ])("keeps a workspace whose nested COMMIT_EDITMSG is %s without reading it unsafely", async (_name, plant) => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      const file = path.join(f.nested.cwd, ".git", "COMMIT_EDITMSG");
      await fs.rm(file, { force: true });
      await plant(file);
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() }))
        .toMatchObject({ expired: false, skipReason: "unsupported_commit_message" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    async function staleRemoteTrackingRef(f: Awaited<ReturnType<typeof nestedFixture>>) {
      git(f.nestedSource, "checkout", "-q", "-b", "squashed-away");
      await fs.writeFile(path.join(f.nestedSource, "feature.txt"), "merged by squash, then deleted\n");
      git(f.nestedSource, "add", "."); git(f.nestedSource, "commit", "-m", "Feature");
      const feature = git(f.nestedSource, "rev-parse", "HEAD");
      git(f.nestedSource, "push", "-q", f.nestedRemote, "squashed-away");
      git(f.nestedSource, "checkout", "-q", "main");
      git(f.nested.cwd, "fetch", "-q", "origin", "+refs/heads/squashed-away:refs/remotes/origin/squashed-away");
      git(f.nestedRemote, "branch", "-D", "squashed-away");
      git(f.nestedRemote, "reflog", "expire", "--expire=now", "--all");
      git(f.nestedRemote, "gc", "-q", "--prune=now");
      expect(() => git(f.nestedRemote, "cat-file", "-e", `${feature}^{commit}`)).toThrow();
      return feature;
    }

    it("saves a clean nested checkout's stale remote-tracking commits in its restore point", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      const feature = await staleRemoteTrackingRef(f);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
      expect(recipe.contents.checkouts[0].restorePoint).toMatchObject({ head: f.nestedA, headOnRemote: true, worktree: null });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      expect(git(f.nested.cwd, "cat-file", "-t", feature)).toBe("commit");
      vi.unstubAllEnvs();
    });

    it("rolls back when a nested checkout's remote-tracking refs change after capture", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await staleRemoteTrackingRef(f);
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint(), beforeDelete: async () => {
        const later = execFileSync("git", ["commit-tree", git(f.nested.cwd, "rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "Fetched after capture"],
          { cwd: f.nested.cwd, env: gitEnv, encoding: "utf8" }).trim();
        git(f.nested.cwd, "update-ref", "refs/remotes/origin/fetched-later", later);
      } });
      expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("rolls back when only a nested checkout's remote-tracking reflog changes after capture", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await staleRemoteTrackingRef(f);
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint(), beforeDelete: async () => {
        const tip = git(f.nested.cwd, "rev-parse", "refs/remotes/origin/squashed-away");
        git(f.nested.cwd, "update-ref", "-m", "moved", "--create-reflog", "refs/remotes/origin/squashed-away", f.nestedA);
        git(f.nested.cwd, "update-ref", "-m", "moved back", "refs/remotes/origin/squashed-away", tip);
      } });
      expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
      vi.unstubAllEnvs();
    });

    it("counts distinct reflog commits, not repeated entries, against the tip budget", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      const head = git(f.nested.cwd, "rev-parse", "HEAD");
      const log = path.join(f.nested.cwd, ".git", "logs", "refs", "heads", "main");
      const entry = `${head} ${head} Fixture <fixture@example.test> 1700000000 +0000\treset: moving to HEAD\n`;
      await fs.appendFile(log, entry.repeat(6_000));
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      vi.unstubAllEnvs();
    });

    it("expires despite a stale pending restore point left by an earlier attempt", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      const generation = Number((await f.row()).metadata?.lifecycleGeneration ?? 0) + 1;
      const base = { companyId: f.companyId, executionWorkspaceId: f.workspaceId, sourceIssueId: f.issueId, generation,
        sha256: "0".repeat(64), byteSize: 1 };
      const [stale] = await db.insert(executionWorkspaceRestorePoints).values([
        { ...base, checkoutName: path.basename(f.nested.cwd), objectKey: `stale/${randomUUID()}.pcrp`, status: "pending" },
        { ...base, checkoutName: "", objectKey: `stale/${randomUUID()}.pcrp`, status: "superseded" },
      ]).returning();
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      const rows = await ledger(f.workspaceId);
      expect(rows.find(row => row.id === stale!.id)).toMatchObject({ status: "superseded" });
      expect(rows.filter(row => row.status === "active").map(row => row.checkoutName)).toEqual([path.basename(f.nested.cwd)]);
      vi.unstubAllEnvs();
    });

    it("keeps a workspace whose nested checkout has unpushed work on another branch", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      git(f.nested.cwd, "checkout", "-q", "-b", "side");
      await fs.writeFile(path.join(f.nested.cwd, "side.txt"), "side branch work\n");
      git(f.nested.cwd, "add", "side.txt"); git(f.nested.cwd, "commit", "-q", "-m", "Side work");
      git(f.nested.cwd, "checkout", "-q", "main");
      await fs.writeFile(path.join(f.nested.cwd, "draft.md"), "untracked\n");
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() }))
        .toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout_branches" });
      expect(await exists(f.cwd)).toBe(true);
      expect(await ledger(f.workspaceId)).toEqual([]);
      vi.unstubAllEnvs();
    });

    it("keeps the workspace and drops every restore point when a nested checkout changes after capture", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await nestedFixture(false);
      await unpushedNestedWork(f.nested.cwd);
      const result = await f.expire({ expireBase: false, restorePoint: restorePoint(),
        beforeDelete: async () => { await fs.writeFile(path.join(f.nested.cwd, "draft.md"), "changed after capture\n"); } });
      expect(result).toMatchObject({ expired: false, skipReason: "restore_point_contents_changed" });
      expect(await fs.readFile(path.join(f.nested.cwd, "draft.md"), "utf8")).toBe("changed after capture\n");
      const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
      expect(recipe.schema).toBe("paperclip.git-cache-restoration.v1");
      expect(recipe.contents.checkouts[0].restorePoint).toBeUndefined();
      expect(await ledger(f.workspaceId)).toMatchObject([{ status: "superseded" }]);
      vi.unstubAllEnvs();
    });
  });

  it("retains custom base ignore patterns after expiring the nested workspace", async () => {
    const f = await nestedFixture(false);
    const exclude = path.join(f.baseCwd, ".git", "info", "exclude");
    await fs.appendFile(exclude, "private-output/\n");
    const original = await fs.readFile(exclude);
    expect(await f.expire()).toMatchObject({ expired: true, baseExpired: false, skipReason: "custom_git_metadata" });
    expect(await exists(f.cwd)).toBe(false);
    expect(await exists(f.baseCwd)).toBe(true);
    expect(await fs.readFile(exclude)).toEqual(original);
  });

  async function crashWithExpirationLocks(f: Awaited<ReturnType<typeof nestedFixture>>, beforePublication = false) {
    expect(await f.expire({ beforeDelete: async () => { throw new Error("stop_before_locks"); } }))
      .toMatchObject({ expired: false, skipReason: "stop_before_locks" });
    const row = await f.row();
    const locations = await gitCacheExpirationLockLocations(row);
    const token = readGitCacheExpiration(row)!.lockToken!;
    const module = new URL("../services/git-workspace-expiration-locks.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
      import fs from 'node:fs/promises';
      import { acquireGitExpirationLocks } from ${JSON.stringify(module)};
      ${beforePublication ? "fs.link = async () => process.exit(71);" : ""}
      await acquireGitExpirationLocks(${JSON.stringify(locations)}, ${JSON.stringify(token)});
      process.exit(71);
    `], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(71);
    return locations;
  }

  it("recovers expiration-owned main and nested locks after process exit before retrying cleanup", async () => {
    const f = await nestedFixture();
    const locations = await crashWithExpirationLocks(f);
    for (const location of locations) expect(await exists(path.join(location.root, location.relativePath))).toBe(true);
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.nestedSettingsPath)).toEqual(f.settings);
  });

  it("ordinary reopening recovers process-abandoned main and nested locks", async () => {
    const f = await nestedFixture();
    const locations = await crashWithExpirationLocks(f);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    for (const location of locations) expect(await exists(path.join(location.root, location.relativePath))).toBe(false);
    await fs.writeFile(path.join(f.nested.cwd, "continued.txt"), "continued after crash\n");
    git(f.nested.cwd, "add", "."); git(f.nested.cwd, "commit", "-m", "Continued after crash");
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).not.toBe(f.nestedA);
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
  });

  it("recovers an unpublished lock temporary file and a surviving branch lock after rename", async () => {
    const f = await nestedFixture();
    const locations = await crashWithExpirationLocks(f, true);
    for (const location of locations) expect(await exists(path.join(location.root, location.relativePath))).toBe(false);
    expect(await f.reopen()).toMatchObject({ ok: true });
    const firstAdmin = path.dirname(path.join(locations[0]!.root, locations[0]!.relativePath));
    expect((await fs.readdir(firstAdmin)).filter(name => name.startsWith(".paperclip-expiration-"))).toEqual([]);

    const g = await nestedFixture();
    const remaining = await crashWithExpirationLocks(g);
    const state = readGitCacheExpiration(await g.row())!;
    await fs.rename(g.cwd, state.worktreeTrash);
    expect(await g.reopen()).toMatchObject({ ok: true });
    for (const location of remaining) expect(await exists(path.join(location.root, location.relativePath))).toBe(false);
    expect(git(g.cwd, "rev-parse", "HEAD")).toBe(g.commitA);
    expect(git(g.nested.cwd, "rev-parse", "HEAD")).toBe(g.nestedA);
  });

  it("retains lock ownership when rollback is interrupted before releasing native locks", async () => {
    const f = await nestedFixture();
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, "unlink").mockImplementation(async target => {
      if (path.basename(String(target)) === "HEAD.lock") throw new Error("lock_release_failed");
      return unlink(target);
    });
    expect(await f.expire({ beforeDelete: async () => { await fs.writeFile(f.settingsPath, "changed during expiration\n"); } }))
      .toMatchObject({ expired: false, skipReason: "lock_release_failed" });
    expect((await f.row()).status).toBe("archived");
    expect(readGitCacheExpiration(await f.row())?.lockToken).toMatch(/^[a-f0-9]{64}$/);
    failure.mockRestore();
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "local_settings_changed" });
    expect((await f.row()).status).toBe("active");
    expect((await f.row()).metadata?.gitCacheExpiration).toBeUndefined();
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe("changed during expiration\n");
    await fs.writeFile(path.join(f.nested.cwd, "continued.txt"), "continued after rollback\n");
    git(f.nested.cwd, "add", "."); git(f.nested.cwd, "commit", "-m", "Continued after rollback");
  });

  it("preserves a foreign Git lock when recovering an interrupted expiration", async () => {
    const f = await nestedFixture();
    const locations = await crashWithExpirationLocks(f);
    const target = path.join(locations[0]!.root, locations[0]!.relativePath);
    await fs.writeFile(target, "foreign Git lock\n");
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "git_expiration_lock_conflict" });
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await fs.readFile(target, "utf8")).toBe("foreign Git lock\n");
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
  });

  it("restores nested checkout commits and local settings after upstream advances", async () => {
    const f = await nestedFixture();
    const { nestedSource, nestedRemote, nestedA, preparation, nested, settings, settingsPath } = f;
    await fs.writeFile(path.join(nestedSource, "nested.txt"), "nested B\n");
    git(nestedSource, "add", "."); git(nestedSource, "commit", "-m", "Nested B");
    git(nestedSource, "push", nestedRemote, "main");
    await f.advance();
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await exists(f.cwd)).toBe(false);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await prepareProjectRepositoryWorkspaces(preparation);
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    expect(git(nested!.cwd, "rev-parse", "HEAD")).toBe(nestedA);
    expect(await fs.readFile(settingsPath)).toEqual(settings);
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(f.nestedSettingsPath)).toEqual(settings);
    expect((await fs.stat(f.nestedSettingsPath)).mode & 0o777).toBe(0o640);
    expect(JSON.stringify((await f.row()).metadata)).not.toContain("preserve-me");
    await fs.writeFile(path.join(nested.cwd, "continued.txt"), "nested C\n");
    git(nested.cwd, "add", "."); git(nested.cwd, "commit", "-m", "Nested continued");
    const continued = git(nested.cwd, "rev-parse", "HEAD");
    await fs.writeFile(settingsPath, "user changes after reopening\n");
    await ensurePersistedExecutionWorkspaceAvailable({ db, base: f.base,
      workspace: (await executionWorkspaceService(db).getStoredById(f.companyId, f.workspaceId))!,
      issue: { id: f.issueId, identifier: "GC-1", title: "Resumed task" },
      agent: { id: null, name: "Fixture", companyId: f.companyId }, skipHostProvision: true });
    await prepareProjectRepositoryWorkspaces(preparation);
    expect(git(nested.cwd, "rev-parse", "HEAD")).toBe(continued);
    expect(await fs.readFile(settingsPath, "utf8")).toBe("user changes after reopening\n");
  });

  it("restores saved contents before the provision command observes the workspace", async () => {
    const f = await nestedFixture();
    const probe = path.join(path.dirname(f.source), "provision-probe.cjs");
    const observed = path.join(path.dirname(f.source), "provision-observed.txt");
    await fs.writeFile(probe, `const fs = require('node:fs'); const cp = require('node:child_process');
      if (cp.execFileSync('git', ['-C', ${JSON.stringify(f.nested.cwd)}, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim() !== ${JSON.stringify(f.nestedA)}) throw Error('wrong nested commit');
      if (fs.readFileSync(${JSON.stringify(f.settingsPath)}).toString('base64') !== ${JSON.stringify(f.settings.toString('base64'))}) throw Error('wrong settings');
      fs.writeFileSync(${JSON.stringify(observed)}, 'restored before provision');`);
    const [primary] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId!,
      name: "Primary repository", cwd: f.baseCwd, repoUrl: f.base.repoUrl, isPrimary: true }).returning();
    await db.update(issues).set({ projectId: f.projectId }).where(eq(issues.id, f.issueId));
    const row = await f.row();
    await db.update(executionWorkspaces).set({ projectWorkspaceId: primary!.id, metadata: { ...row.metadata,
      config: { provisionCommand: `node ${JSON.stringify(probe)}` } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(await fs.readFile(observed, "utf8")).toBe("restored before provision");
  });

  it.each(["failed_provision", "transaction_rollback"])("retries %s without discarding its restored workspace edits", async failure => {
    const f = await nestedFixture();
    const probe = path.join(path.dirname(f.source), "provision-retry.cjs");
    const observed = path.join(path.dirname(f.source), "provision-retry.txt");
    const changedSettings = "settings updated by provisioning\n";
    await fs.writeFile(probe, `const fs = require('node:fs');
      if (!fs.existsSync(${JSON.stringify(observed)})) {
        fs.writeFileSync(${JSON.stringify(f.settingsPath)}, ${JSON.stringify(changedSettings)});
        fs.writeFileSync(${JSON.stringify(observed)}, 'first attempt');
        process.exit(1);
      }
      if (fs.readFileSync(${JSON.stringify(f.settingsPath)}, 'utf8') !== ${JSON.stringify(changedSettings)}) throw Error('lost provision edits');
      fs.writeFileSync(${JSON.stringify(observed)}, 'second attempt succeeded');`);
    const [primary] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId!,
      name: "Primary repository", cwd: f.baseCwd, repoUrl: f.base.repoUrl, isPrimary: true }).returning();
    await db.update(issues).set({ projectId: f.projectId }).where(eq(issues.id, f.issueId));
    const row = await f.row();
    await db.update(executionWorkspaces).set({ projectWorkspaceId: primary!.id, metadata: { ...row.metadata,
      config: { provisionCommand: `node ${JSON.stringify(probe)}` } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await f.expire()).expired).toBe(true);
    if (failure === "transaction_rollback") {
      const record = activityLog.logActivity;
      vi.spyOn(activityLog, "logActivity").mockImplementation(async (...args) => {
        if (args[1].action === "execution_workspace.reopen_failed") throw new Error("interrupted_reopen_transaction");
        return record(...args);
      });
    }
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(changedSettings);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ contentsRestoredAt: expect.any(String) });
    expect((await f.row()).metadata?.gitCacheRestoration).not.toHaveProperty("restoredAt");
    vi.restoreAllMocks();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(observed, "utf8")).toBe("second attempt succeeded");
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(changedSettings);
  });

  it("resets the contents checkpoint before retrying a missing restored workspace", async () => {
    const f = await nestedFixture();
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ contentsRestoredAt: expect.any(String), restoredAt: expect.any(String) });
    await fs.rm(f.cwd, { recursive: true });
    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await fs.rename(f.nestedRemote, `${f.nestedRemote}.offline`);
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ contentsRestoredAt: null, restoredAt: expect.any(String) });
    await fs.rename(`${f.nestedRemote}.offline`, f.nestedRemote);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
  });

  it("resumes settings publication after linking but before temporary-file removal", async () => {
    const f = await nestedFixture();
    const settingsDirectory = await fs.realpath(path.dirname(f.settingsPath));
    expect((await f.expire()).expired).toBe(true);
    const originalRemove = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (path.dirname(String(target)) === settingsDirectory && String(target).includes(".settings-restore-")) throw new Error("interrupted_settings_publication");
      return originalRemove(target, options);
    });
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect((await fs.stat(f.settingsPath)).nlink).toBe(2);
    remove.mockRestore();
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect((await fs.stat(f.settingsPath)).nlink).toBe(1);
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
  });

  it("retains tracked local settings whose permissions Git cannot reproduce", async () => {
    const f = await nestedFixture();
    git(f.cwd, "add", "-f", ".claude/settings.local.json");
    git(f.cwd, "commit", "-m", "Tracked settings");
    git(f.cwd, "push", "origin", "HEAD:refs/heads/fixture-task");
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "tracked_local_settings" });
    expect((await fs.stat(f.settingsPath)).mode & 0o777).toBe(0o600);
  });

  it.each(["repoRef", "cwd"])("keeps the restored checkout through preparation after project %s changes", async selection => {
    const f = await nestedFixture();
    await fs.writeFile(path.join(f.nestedSource, "nested.txt"), "nested B\n");
    git(f.nestedSource, "add", "."); git(f.nestedSource, "commit", "-m", "Nested B");
    git(f.nestedSource, "push", f.nestedRemote, "HEAD:refs/heads/release");
    expect((await f.expire()).expired).toBe(true);
    const updated = await db.update(projectWorkspaces).set(selection === "repoRef" ? { repoRef: "release" } : { cwd: f.nestedSource })
      .where(eq(projectWorkspaces.id, f.preparation.workspaces[0]!.id)).returning();
    expect(await f.reopen()).toMatchObject({ ok: true });
    const row = await f.row();
    const prepared = await prepareProjectRepositoryWorkspaces({ ...f.preparation, workspaces: updated,
      restoredContents: readGitCacheRestoration(row)?.contents });
    expect(prepared).toEqual([f.nested]);
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.nestedSettingsPath)).toEqual(f.settings);
    expect(await exists(path.join(f.cwd, ".paperclip-runtime", "detached-repositories"))).toBe(false);
    await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, reopenPendingConsumption: false } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await f.expire()).toMatchObject({ expired: true });
  });

  it("does not replace a missing restored checkout or admit a changed repository", async () => {
    const f = await nestedFixture();
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    const restoredContents = readGitCacheRestoration(await f.row())?.contents;
    await expect(prepareProjectRepositoryWorkspaces({ ...f.preparation, restoredContents,
      workspaces: [{ ...f.preparation.workspaces[0]!, repoUrl: pathToFileURL(f.source).href }] })).rejects.toThrow("could not be restored");
    await fs.rename(f.nested.cwd, `${f.nested.cwd}.retained`);
    await expect(prepareProjectRepositoryWorkspaces({ ...f.preparation, restoredContents })).rejects.toThrow("could not be restored");
    expect(await exists(f.nested.cwd)).toBe(false);
    expect(git(`${f.nested.cwd}.retained`, "rev-parse", "HEAD")).toBe(f.nestedA);
  });

  it("retries a partial nested restoration when upstream returns", async () => {
    const f = await nestedFixture();
    expect((await f.expire()).expired).toBe(true);
    await fs.rename(f.nestedRemote, `${f.nestedRemote}.offline`);
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).metadata?.gitCacheRestoration).not.toHaveProperty("restoredAt");
    await fs.rename(`${f.nestedRemote}.offline`, f.nestedRemote);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    expect(await fs.readFile(f.settingsPath)).toEqual(f.settings);
  });

  it.each(["settings", "checkout", "legacy_recipe"])("retains changed %s and permits ordinary reopening", async kind => {
    const f = await nestedFixture();
    if (kind === "legacy_recipe") {
      expect((await f.expire({ beforeDelete: async () => { throw new Error("stop_before_delete"); } })).expired).toBe(false);
      const row = await f.row();
      const recipe = { ...(row.metadata!.gitCacheRestoration as Record<string, unknown>) };
      delete recipe.contents;
      await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, gitCacheRestoration: recipe } }).where(eq(executionWorkspaces.id, f.workspaceId));
    }
    const outcome = await f.expire({ beforeDelete: async () => {
      if (kind === "settings") await fs.writeFile(f.settingsPath, "new local settings\n");
      if (kind === "checkout") {
        await fs.writeFile(path.join(f.nested.cwd, "nested.txt"), "nested B\n");
        git(f.nested.cwd, "add", "."); git(f.nested.cwd, "commit", "-m", "Nested B");
        git(f.nested.cwd, "push", "origin", "main");
      }
    } });
    expect(outcome).toMatchObject({ expired: false, reclaimedBytes: 0 });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(kind === "settings" ? "new local settings\n" : f.settings.toString());
    expect(await fs.readFile(path.join(f.nested.cwd, "nested.txt"), "utf8")).toBe(kind === "checkout" ? "nested B\n" : "nested A\n");
  });

  it("expires again after a reopened task consumes its fence and finishes", async () => {
    const f = await fixture();
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await db.update(issues).set({ status: "in_progress", completedAt: null }).where(eq(issues.id, f.issueId));
    const worker = executionWorkspaceService(db, { gitCacheExpirationEnabled: true, gitBaseExpirationEnabled: true });
    await worker.sweepTerminalWorkspaces();
    expect((await f.row()).metadata?.reopenPendingConsumption).not.toBe(true);
    await fs.writeFile(path.join(f.cwd, "continued.txt"), "second task cycle\n");
    git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "Second task cycle");
    git(f.cwd, "push", "origin", "HEAD:refs/heads/continued");
    const continued = git(f.cwd, "rev-parse", "HEAD");
    await db.update(issues).set({ status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) }).where(eq(issues.id, f.issueId));
    expect((await worker.sweepTerminalWorkspaces()).archived).toBe(1);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ commit: continued });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(continued);
  });

  it("prepares a restored workspace after adopting its renamed branch", async () => {
    const f = await fixture();
    await f.advance();
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    git(f.cwd, "branch", "-m", "renamed-task");
    await db.update(executionWorkspaces).set({ status: "idle" }).where(eq(executionWorkspaces.id, f.workspaceId));
    const svc = executionWorkspaceService(db);
    await svc.reconcileExecutionWorkspaceBranch(f.workspaceId, {
      mode: "forward", actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null },
    });
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({
      branchName: "renamed-task", commit: f.commitA, restoredAt: expect.any(String),
    });
    await ensurePersistedExecutionWorkspaceAvailable({ db, base: f.base,
      workspace: (await svc.getStoredById(f.companyId, f.workspaceId))!,
      issue: { id: f.issueId, identifier: "GC-1", title: "Resumed task" },
      agent: { id: null, name: "Fixture", companyId: f.companyId }, skipHostProvision: true });
    expect(git(f.cwd, "branch", "--show-current")).toBe("renamed-task");
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("preserves worktrees whose Git administration parent is a symlink", async () => {
    const f = await fixture();
    const adminParent = path.join(f.baseCwd, ".git", "worktrees");
    const external = path.join(root, `external-admin-${randomUUID()}`);
    const admin = git(f.cwd, "rev-parse", "--absolute-git-dir");
    await fs.writeFile(path.join(admin, "commondir"), `${path.join(f.baseCwd, ".git")}\n`);
    await fs.rename(adminParent, external);
    await fs.symlink(external, adminParent);
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "unproven_worktree_admin" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await fs.readdir(external)).not.toEqual([]);
    expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
  });

  it.each(["dirty", "untracked", "ignored", "local_commit", "stash", "unknown_git_file"])("preserves %s unique state", async kind => {
    const f = await fixture();
    if (kind === "dirty") await fs.writeFile(path.join(f.cwd, "marker.txt"), "unique changes");
    if (kind === "untracked") await fs.writeFile(path.join(f.cwd, "notes.txt"), "unique notes");
    if (kind === "ignored") { await fs.mkdir(path.join(f.cwd, "private-notes")); await fs.writeFile(path.join(f.cwd, "private-notes", "note"), "unique ignored"); }
    if (kind === "local_commit") { await fs.writeFile(path.join(f.cwd, "new.txt"), "unique commit"); git(f.cwd, "add", "."); git(f.cwd, "commit", "-m", "Unpushed"); }
    if (kind === "stash") { await fs.writeFile(path.join(f.cwd, "marker.txt"), "stash"); git(f.cwd, "stash"); }
    if (kind === "unknown_git_file") await fs.writeFile(path.join(git(f.cwd, "rev-parse", "--absolute-git-dir"), "unique-note"), "unique Git data");
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true); expect(await exists(f.baseCwd)).toBe(true);
  });

  it("preserves live descendants and pending reopening", async () => {
    const f = await fixture();
    await db.insert(issues).values({ companyId: f.companyId, title: "Active child", status: "in_progress", parentId: f.issueId,
      executionWorkspaceId: f.workspaceId, executionWorkspacePreference: "reuse_existing" });
    expect((await f.expire()).expired).toBe(false);
    await db.delete(issues).where(eq(issues.parentId, f.issueId));
    const row = await f.row();
    await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, reopenPendingConsumption: true } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true);
  });

  it("describes an unexpected inspection failure without the command or credentials", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, ".git"), `gitdir: ${path.join(f.cwd, "missing-admin")}\n`);
    const result = await f.expire();
    expect(result).toMatchObject({ expired: false, skipReason: "inspection_failed",
      failure: { name: "Error", code: expect.any(String), at: expect.stringMatching(/^at /), stderr: expect.stringMatching(/not a git repository|gitfile does not point to a valid repository/) } });
    expect(await exists(f.cwd)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("describes an unexpected failure while inspecting the base", async () => {
    const f = await fixture();
    const locked = path.join(f.baseCwd, "locked-dir");
    const result = await f.expire({ beforeDelete: async () => {
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, "file"), "x");
      await fs.chmod(locked, 0o000);
    } });
    await fs.chmod(locked, 0o755);
    expect(result).toMatchObject({ expired: true, baseExpired: false, skipReason: "inspection_failed",
      failure: { code: "EACCES", at: expect.stringMatching(/^at /) } });
  });

  it("redacts credentials from a described git failure", async () => {
    const error = await promisify(execFile)("git", ["-c", "http.extraHeader=Authorization: Bearer sk-secret-header",
      "ls-remote", "https://user:sk-secret-pass@127.0.0.1:9/repo.git"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
      .then(() => { throw new Error("expected git to fail"); }, (error: Error) => error);
    const described = describeGitExpirationFailure(error);
    expect(JSON.stringify(described)).not.toContain("sk-secret");
    expect(JSON.stringify(described)).not.toContain("ls-remote");
    expect(described).toMatchObject({ name: "Error", code: expect.any(String), stderr: expect.any(String) });
  });

  it("redacts credentials that git echoes on stderr", () => {
    const error = Object.assign(new Error("Command failed: git fetch https://user:sk-secret-pass@example.test/repo.git"), {
      code: 128, stderr: "fatal: unable to access 'https://user:sk-secret-pass@example.test/repo.git/'\nheader Authorization: Bearer sk-secret-header\n" });
    const described = describeGitExpirationFailure(error);
    expect(JSON.stringify(described)).not.toContain("sk-secret");
    expect(described.stderr).toContain("https://<redacted>@example.test/repo.git");
    expect(described.code).toBe("128");
  });

  it("retries after interruption with the restoration recipe already committed", async () => {
    const f = await fixture();
    expect((await f.expire({ beforeDelete: async () => { throw new Error("interrupted_fixture"); } })).expired).toBe(false);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ commit: f.commitA });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.expire()).expired).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("fails restoration explicitly on upstream failure and rejects a different company", async () => {
    const f = await fixture();
    expect((await f.expire()).baseExpired).toBe(true);
    await fs.rename(f.remote, `${f.remote}.offline`);
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed", message: "The saved workspace commit could not be restored. Check repository access and retry." });
    expect(await f.reopen(randomUUID())).toMatchObject({ ok: false, code: "not_reopenable" });
    expect(await exists(f.cwd)).toBe(false);
    await fs.rename(`${f.remote}.offline`, f.remote);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });
  it("serializes concurrent reopening after deletion and publishes one transition", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const expiration = f.expire({ beforeDelete: async () => { entered(); await paused; } });
    await ready;
    const first = f.reopen(), second = f.reopen();
    release();
    expect((await expiration).expired).toBe(true);
    const results = await Promise.all([first, second]);
    expect(results, JSON.stringify(results)).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, reopened: true }), expect.objectContaining({ ok: true, reopened: false })]));
    expect(results.filter(result => result.ok && result.reopened)).toHaveLength(1);
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("recovers interrupted trash removal before reopening", async () => {
    const f = await fixture();
    const originalRemove = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(".expired-git-worktree-")) throw new Error("interrupted_trash_fixture");
      return originalRemove(target, options);
    });
    expect((await f.expire()).skipReason).toBe("interrupted_trash_fixture");
    expect(await exists(f.cwd)).toBe(false);
    expect((await f.row()).metadata?.gitCacheRestoration).toMatchObject({ commit: f.commitA });
    remove.mockRestore();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("preserves scheduled runs, unresolved recovery, and live previews", async () => {
    const f = await fixture();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Fixture", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, nativeIssueId: f.issueId, status: "scheduled_retry" });
    expect((await f.expire()).expired).toBe(false);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed", recoveryState: "resuming_session" });
    expect((await f.expire()).expired).toBe(false);
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: "native-finalizer:live" }).where(eq(nativeRunFinalizations.runId, runId)); expect((await f.expire()).expired).toBe(false);
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      scopeType: "execution_workspace", serviceName: "Preview", status: "running", lifecycle: "persistent", provider: "local" });
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true);
  });

  it("expires a closed tree whose native recovery state was left behind", async () => {
    const f = await fixture(), agentId = randomUUID(), runIds = [randomUUID(), randomUUID()];
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Fixture", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values(runIds.map(id => ({ id, companyId: f.companyId, agentId, nativeIssueId: f.issueId, status: "succeeded", finishedAt: new Date(Date.now() - 48 * 3_600_000) })));
    await db.insert(nativeRunFinalizations).values([["committed", "resuming_session"], ["terminal_failure", "blocked"]].map(([phase, recoveryState], i) => ({ runId: runIds[i]!, companyId: f.companyId, issueId: f.issueId, phase, recoveryState })));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerAgentId: agentId,
      cause: "native_finalization_error", fingerprint: randomUUID(), nextAction: "Resume the native run.", wakePolicy: { kind: "resume_native_run", runId: runIds[0] } });
    expect(await f.expire()).toMatchObject({ expired: true }); expect(await exists(f.cwd)).toBe(false);
  });

  it("skips deletion when authenticated upstream verification fails", async () => {
    const f = await fixture();
    await fs.rename(f.remote, `${f.remote}.offline`);
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).metadata?.gitCacheRestoration).toBeUndefined();
  });

  it("keeps an unused base containing custom Git files", async () => {
    const f = await fixture();
    const note = path.join(f.baseCwd, ".git", "private-note");
    await fs.writeFile(note, "unique base metadata");
    const outcome = await f.expire();
    expect(outcome).toMatchObject({ expired: true, baseExpired: false, skipReason: "unknown_base_git_files" });
    expect(await fs.readFile(note, "utf8")).toBe("unique base metadata");
    expect(await f.reopen()).toMatchObject({ ok: true });
  });

  it("expires owned task worktrees while preserving their shared managed base", async () => {
    const f = await fixture(true, true);
    await f.advance();
    expect(await f.expire()).toMatchObject({ expired: true, baseExpired: false, skipReason: "shared_base_preserved" });
    expect(await exists(f.baseCwd)).toBe(true);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it("expires an isolated base whose worktree was nested inside it", async () => {
    const f = await fixture(false, true);
    await fs.mkdir(path.join(f.baseCwd, ".git", "branches"), { recursive: true });
    expect(await f.expire()).toMatchObject({ expired: true, baseExpired: true });
    expect(await exists(f.baseCwd)).toBe(false);
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });

  it.each(["file", "symlink"])("preserves a legacy branches directory with %s data", async kind => {
    const f = await fixture(false, true);
    const branches = path.join(f.baseCwd, ".git", "branches");
    await fs.mkdir(branches, { recursive: true });
    const note = path.join(branches, "saved-remote");
    await fs.writeFile(note, "unique legacy remote\n");
    if (kind === "symlink") {
      const target = path.join(root, `legacy-branches-${randomUUID()}`);
      await fs.rename(branches, target);
      await fs.symlink(target, branches);
    }
    expect(await f.expire()).toMatchObject({ expired: true, baseExpired: false, skipReason: "custom_git_metadata" });
    expect(await fs.readFile(note, "utf8")).toBe("unique legacy remote\n");
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, expired: false, skipReason: "custom_git_metadata" });
    expect(await f.reopen()).toMatchObject({ ok: true });
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.commitA);
  });


  describe("nested checkouts as worktrees of a shared base", () => {
    const restorePoint = () => ({ storage: getStorageService(), notBefore: new Date(Date.now() - 24 * 3_600_000), keyDurable: true });
    const worktrees = (base: string) => git(base, "worktree", "list", "--porcelain").split("\n")
      .filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
    const real = (target: string) => fs.realpath(target);
    async function sharedFixture() {
      const f = await nestedFixture(false, true);
      const siblingCwd = path.join(path.dirname(f.source), "sibling-task");
      await fs.mkdir(siblingCwd);
      const [sibling] = await prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: siblingCwd });
      return { ...f, siblingCwd, sibling: sibling! };
    }

    it("prepares nested checkouts of two tasks as worktrees of one shared clone", async () => {
      const f = await sharedFixture();
      const base = await real(f.sharedBase);
      for (const checkout of [f.nested.cwd, f.sibling.cwd]) {
        expect((await fs.lstat(path.join(checkout, ".git"))).isFile()).toBe(true);
        expect(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(base, ".git"));
        expect(git(checkout, "rev-parse", "HEAD")).toBe(f.nestedA);
        expect(git(checkout, "remote", "get-url", "origin")).toBe(pathToFileURL(f.nestedRemote).href);
        expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toMatch(/^paperclip\/[a-f0-9]{12}\/main$/);
        expect(git(checkout, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      }
      expect(git(f.nested.cwd, "symbolic-ref", "HEAD")).not.toBe(git(f.sibling.cwd, "symbolic-ref", "HEAD"));
      expect(await worktrees(base)).toEqual(expect.arrayContaining([await real(f.nested.cwd), await real(f.sibling.cwd)]));
      expect(await prepareProjectRepositoryWorkspaces(f.preparation)).toMatchObject([{ cwd: f.nested.cwd }]);
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    });

    it("serializes concurrent preparation of tasks sharing one base", async () => {
      const f = await nestedFixture(false, true);
      const tasks = await Promise.all([1, 2, 3].map(async index => {
        const cwd = path.join(path.dirname(f.source), `concurrent-${index}`);
        await fs.mkdir(cwd);
        return cwd;
      }));
      const prepared = await Promise.all(tasks.map(cwd => prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd })));
      const base = await real(f.sharedBase);
      for (const [repository] of prepared) {
        expect(git(repository!.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(base, ".git"));
      }
      expect(await worktrees(base)).toEqual(expect.arrayContaining(await Promise.all(prepared.map(([repository]) => real(repository!.cwd)))));
      const waiting = path.join(path.dirname(f.source), "waiting-task");
      await fs.mkdir(waiting);
      let release!: () => void;
      const held = withNestedRepositoryBaseLock(f.sharedBase, () => new Promise<void>(resolve => { release = resolve; }));
      const pending = prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: waiting });
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await exists(path.join(waiting, ".paperclip-repositories", path.basename(f.nested.cwd)))).toBe(false);
      release();
      await held;
      const [late] = await pending;
      expect(git(late!.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(base, ".git"));
    });

    it("tracks a dotted branch ref and proves its tracking configuration", async () => {
      const f = await nestedFixture(false, true);
      git(f.nestedSource, "push", "-q", f.nestedRemote, "main:release-1.0");
      const task = path.join(path.dirname(f.source), "dotted-task");
      await fs.mkdir(task);
      const [prepared] = await prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: task,
        workspaces: [{ ...f.preparation.workspaces[0]!, repoRef: "release-1.0" }] });
      expect(git(prepared!.cwd, "symbolic-ref", "--short", "HEAD")).toMatch(/^paperclip\/[a-f0-9]{12}\/release-1\.0$/);
      expect(git(prepared!.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/release-1.0");
      git(prepared!.cwd, "pull", "-q");
      await expect(assertReproducibleManagedCheckout(prepared!.cwd, { repoUrl: pathToFileURL(f.nestedRemote).href,
        resolveGitAuth: async () => null, baseCandidates: [f.sharedBase] })).resolves.toMatchObject({ headOnRemote: true });
    });

    it("prepares a new branch when a retained checkout still holds the original one", async () => {
      const f = await nestedFixture(false, true);
      git(f.nestedSource, "push", "-q", f.nestedRemote, "main:other");
      const original = git(f.nested.cwd, "symbolic-ref", "HEAD");
      await prepareProjectRepositoryWorkspaces({ ...f.preparation, workspaces: [{ ...f.preparation.workspaces[0]!, repoRef: "other" }] });
      const detachedRoot = path.join(f.cwd, ".paperclip-runtime", "detached-repositories");
      const [retained] = await fs.readdir(detachedRoot);
      expect(git(path.join(detachedRoot, retained!), "symbolic-ref", "HEAD")).toBe(original);
      const [back] = await prepareProjectRepositoryWorkspaces(f.preparation);
      expect(back!.cwd).toBe(f.nested.cwd);
      expect(git(back!.cwd, "symbolic-ref", "HEAD")).toBe(original.replace(/\/main$/, "/r2/main"));
      expect(git(back!.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      expect(git(path.join(detachedRoot, retained!), "symbolic-ref", "HEAD")).toBe(original);
    });

    it("follows a changed remote default branch for new tasks", async () => {
      const f = await nestedFixture(false, true);
      git(f.nestedSource, "push", "-q", f.nestedRemote, "main:trunk");
      git(f.nestedRemote, "symbolic-ref", "HEAD", "refs/heads/trunk");
      const task = path.join(path.dirname(f.source), "default-branch-task");
      await fs.mkdir(task);
      const [prepared] = await prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: task,
        workspaces: [{ ...f.preparation.workspaces[0]!, repoRef: null }] });
      expect(git(prepared!.cwd, "symbolic-ref", "--short", "HEAD")).toMatch(/^paperclip\/[a-f0-9]{12}\/trunk$/);
      expect(git(prepared!.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/trunk");
    });

    it("restores a renumbered owned branch tracking its source branch, not a same-named remote branch", async () => {
      const f = await nestedFixture(false, true);
      git(f.nestedSource, "commit", "-q", "--allow-empty", "-m", "Unrelated r2 branch");
      git(f.nestedSource, "push", "-q", f.nestedRemote, "HEAD:r2/main");
      const base = await real(f.sharedBase);
      git(base, "fetch", "-q", "origin");
      const target = path.join(path.dirname(f.source), "renumbered-task", "checkout");
      await fs.mkdir(path.dirname(target));
      const branchName = `${await nestedWorktreeBranchPrefix(target)}r2/main`;
      await restoreNestedRepositoryWorktree({ base, cwd: target, commit: f.nestedA, branchName, repoRef: null, afterAdd: async () => undefined });
      expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe(branchName);
      expect(git(target, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    });

    it("starts a fully qualified branch ref at the current remote commit and rejects a deleted branch", async () => {
      const f = await nestedFixture(false, true);
      await fs.writeFile(path.join(f.nestedSource, "nested.txt"), "nested B\n");
      git(f.nestedSource, "commit", "-qam", "Nested B");
      git(f.nestedSource, "push", "-q", f.nestedRemote, "main", "main:short-lived");
      const nestedB = git(f.nestedSource, "rev-parse", "HEAD");
      const prepare = async (name: string, repoRef: string) => {
        const task = path.join(path.dirname(f.source), name);
        await fs.mkdir(task);
        return prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: task, workspaces: [{ ...f.preparation.workspaces[0]!, repoRef }] });
      };
      const [qualified] = await prepare("qualified-task", "refs/heads/main");
      expect(git(qualified!.cwd, "rev-parse", "HEAD")).toBe(nestedB);
      expect(git(qualified!.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      await prepare("short-lived-task", "short-lived");
      git(f.nestedRemote, "branch", "-D", "short-lived");
      await expect(prepare("deleted-branch-task", "short-lived")).rejects.toThrow('Repository ref "short-lived" was not found');
    });

    it("never runs hooks planted in the shared clone while preparing or restoring", async () => {
      const f = await nestedFixture(false, true);
      const marker = path.join(path.dirname(f.source), "hook-ran");
      const hooks = path.join(await real(f.sharedBase), ".git", "hooks");
      for (const hook of ["post-checkout", "reference-transaction"]) {
        await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
      }
      const task = path.join(path.dirname(f.source), "hooked-task");
      await fs.mkdir(task);
      await prepareProjectRepositoryWorkspaces({ ...f.preparation, cwd: task });
      const target = path.join(path.dirname(f.source), "hooked-restore", "checkout");
      await fs.mkdir(path.dirname(target));
      await restoreNestedRepositoryWorktree({ base: await real(f.sharedBase), cwd: target, commit: f.nestedA,
        branchName: `${await nestedWorktreeBranchPrefix(target)}main`, repoRef: "main", preserved: [f.nestedA], afterAdd: async () => undefined });
      expect(await exists(marker)).toBe(false);
    });

    it("keeps adopting a legacy standalone nested clone", async () => {
      const f = await nestedFixture(false);
      const [prepared] = await prepareProjectRepositoryWorkspaces({ ...f.preparation, sharedBase: { companyId: f.companyId, projectId: f.projectId! } });
      expect(prepared!.cwd).toBe(f.nested.cwd);
      expect((await fs.lstat(path.join(f.nested.cwd, ".git"))).isDirectory()).toBe(true);
      expect(await exists(f.sharedBase)).toBe(false);
    });

    it("expires a clean nested worktree, unregisters only it, and restores it from the base", async () => {
      const f = await sharedFixture();
      const base = await real(f.sharedBase);
      const ownBranch = git(f.nested.cwd, "symbolic-ref", "HEAD");
      const siblingBranch = git(f.sibling.cwd, "symbolic-ref", "HEAD");
      const nestedPath = await real(f.nested.cwd);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: true, skipReason: null });
      expect(await worktrees(base)).not.toContain(nestedPath);
      expect(await worktrees(base)).toContain(await real(f.sibling.cwd));
      expect(() => git(base, "rev-parse", "--verify", "-q", ownBranch)).toThrow();
      expect(git(base, "rev-parse", siblingBranch)).toBe(f.nestedA);
      const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
      expect(recipe.contents.checkouts[0]).toMatchObject({ commit: f.nestedA, branchName: ownBranch.slice("refs/heads/".length),
        worktree: { base, admin: expect.any(String) } });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect((await fs.lstat(path.join(f.nested.cwd, ".git"))).isFile()).toBe(true);
      expect(git(f.nested.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(base, ".git"));
      expect(git(f.nested.cwd, "symbolic-ref", "HEAD")).toBe(ownBranch);
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      expect(git(f.nested.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      expect(await fs.readFile(f.nestedSettingsPath)).toEqual(f.settings);
      expect(await prepareProjectRepositoryWorkspaces(f.preparation)).toMatchObject([{ cwd: f.nested.cwd }]);
    });

    it("recreates a deleted shared base when restoring an expired nested worktree", async () => {
      const f = await nestedFixture(false, true);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: true });
      await fs.rm(f.sharedBase, { recursive: true, force: true });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(await real(f.sharedBase), ".git"));
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
    });

    it("blocks unpushed nested work and saves it in a restore point", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await sharedFixture();
      const branch = git(f.nested.cwd, "symbolic-ref", "HEAD");
      await fs.writeFile(path.join(f.nested.cwd, "nested.txt"), "nested B (unpushed)\n");
      git(f.nested.cwd, "commit", "-qam", "Nested B unpushed");
      const unpushed = git(f.nested.cwd, "rev-parse", "HEAD");
      await fs.writeFile(path.join(f.nested.cwd, "draft.md"), "nested untracked work\n");
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "dirty_or_untracked_files" });
      await fs.rename(path.join(f.nested.cwd, "draft.md"), path.join(f.siblingCwd, "draft.md"));
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      await fs.rename(path.join(f.siblingCwd, "draft.md"), path.join(f.nested.cwd, "draft.md"));
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "symbolic-ref", "HEAD")).toBe(branch);
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(unpushed);
      expect(await fs.readFile(path.join(f.nested.cwd, "draft.md"), "utf8")).toBe("nested untracked work\n");
      expect(git(f.sibling.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      vi.unstubAllEnvs();
    });

    it("saves history kept only in the nested worktree's reflog and restores it there", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await sharedFixture();
      await fs.writeFile(path.join(f.nested.cwd, "nested.txt"), "rewritten away\n");
      git(f.nested.cwd, "commit", "-qam", "Only in the reflog");
      const orphan = git(f.nested.cwd, "rev-parse", "HEAD");
      git(f.nested.cwd, "reset", "-q", "--hard", "HEAD~1");
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unique_original_head" });
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: true, restorePoint: true });
      git(await real(f.sharedBase), "reflog", "expire", "--expire=now", "--all");
      git(await real(f.sharedBase), "gc", "-q", "--prune=now");
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      expect(git(f.nested.cwd, "reflog", "show", "--format=%H", "HEAD").split("\n")).toContain(orphan);
      expect(git(f.nested.cwd, "cat-file", "-t", orphan)).toBe("commit");
      await expect(assertReproducibleManagedCheckout(f.nested.cwd, { repoUrl: pathToFileURL(f.nestedRemote).href,
        resolveGitAuth: async () => null, baseCandidates: [f.sharedBase] })).rejects.toThrow("unique_reflog_commits");
      vi.unstubAllEnvs();
    });

    it("blocks on stashes, unowned checked-out branches, and unpushed owned branches", async () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
      const f = await sharedFixture();
      await fs.writeFile(path.join(f.nested.cwd, "nested.txt"), "stashed work\n");
      git(f.nested.cwd, "stash", "-q");
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: false, skipReason: "unsupported_local_git_state" });
      git(f.nested.cwd, "stash", "pop", "-q");
      git(f.nested.cwd, "checkout", "-q", "--", "nested.txt");
      const owned = git(f.nested.cwd, "symbolic-ref", "--short", "HEAD");
      git(f.nested.cwd, "checkout", "-q", "-b", "side");
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: false, skipReason: "unowned_nested_worktree_branch" });
      git(f.nested.cwd, "checkout", "-q", owned);
      git(f.nested.cwd, "checkout", "-q", "-b", `${owned}-extra`);
      git(f.nested.cwd, "commit", "-q", "--allow-empty", "-m", "Unpushed extra owned branch");
      git(f.nested.cwd, "checkout", "-q", owned);
      await fs.writeFile(path.join(f.nested.cwd, "draft.md"), "untracked\n");
      expect(await f.expire({ expireBase: false, restorePoint: restorePoint() })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout_branches" });
      expect(await exists(f.cwd)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("blocks an unpushed owned branch or owned reflog entry outside HEAD history", async () => {
      const f = await sharedFixture();
      const owned = git(f.nested.cwd, "symbolic-ref", "--short", "HEAD");
      const orphan = execFileSync("git", ["commit-tree", git(f.nested.cwd, "rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "Owned but unpushed"],
        { cwd: f.nested.cwd, env: gitEnv, encoding: "utf8" }).trim();
      git(f.nested.cwd, "update-ref", "--create-reflog", `refs/heads/${owned}-extra`, orphan);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      git(f.nested.cwd, "update-ref", `refs/heads/${owned}-extra`, f.nestedA);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      git(f.nested.cwd, "update-ref", "-d", `refs/heads/${owned}-extra`);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: true, skipReason: null });
    });

    it("rejects too many owned branches before reading their reflogs", async () => {
      const f = await nestedFixture(false, true);
      const owned = git(f.nested.cwd, "symbolic-ref", "--short", "HEAD");
      const refs = Array.from({ length: 65 }, (_, index) => `create refs/heads/${owned}-many-${index} ${f.nestedA}`).join("\n");
      execFileSync("git", ["update-ref", "--stdin"], { cwd: f.nested.cwd, env: gitEnv, input: `${refs}\n` });
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "managed_checkout_local_tip_budget" });
    });

    it.each([
      ["a named pipe", async (file: string) => { execFileSync("mkfifo", [file]); }],
      ["an oversized file", async (file: string) => { await fs.writeFile(file, "x".repeat(8 * 1024)); }],
      ["a symlink", async (file: string) => { await fs.symlink("/dev/zero", file); }],
    ])("rejects a nested worktree whose administration pointer is %s without reading it unsafely", async (_name, plant) => {
      const f = await nestedFixture(false, true);
      const admin = git(f.nested.cwd, "rev-parse", "--absolute-git-dir");
      const pointer = path.join(admin, "gitdir");
      await fs.rm(pointer);
      await plant(pointer);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unproven_managed_checkout" });
      await expect(prepareProjectRepositoryWorkspaces(f.preparation)).rejects.toThrow("Invalid project repository checkout path");
    });

    it("ignores another task's unpushed branch and keeps it after expiring this worktree", async () => {
      const f = await sharedFixture();
      git(f.sibling.cwd, "commit", "-q", "--allow-empty", "-m", "Sibling unpushed work");
      const siblingWork = git(f.sibling.cwd, "rev-parse", "HEAD");
      const siblingBranch = git(f.sibling.cwd, "symbolic-ref", "HEAD");
      git(f.nested.cwd, "branch", "agent-shared-branch", siblingWork);
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: true, skipReason: null });
      const base = await real(f.sharedBase);
      expect(git(base, "rev-parse", siblingBranch)).toBe(siblingWork);
      expect(git(base, "rev-parse", "refs/heads/agent-shared-branch")).toBe(siblingWork);
      expect(git(f.sibling.cwd, "rev-parse", "HEAD")).toBe(siblingWork);
    });

    it("rejects a nested worktree whose base is not the project's shared clone", async () => {
      const f = await sharedFixture();
      const foreign = path.join(path.dirname(f.source), "foreign-base");
      git(path.dirname(f.source), "clone", "-q", pathToFileURL(f.nestedRemote).href, foreign);
      git(f.nested.cwd, "checkout", "-q", "--detach");
      const ownBranch = git(f.sibling.cwd, "symbolic-ref", "HEAD");
      await fs.rm(f.nested.cwd, { recursive: true, force: true });
      git(await real(f.sharedBase), "worktree", "prune");
      git(foreign, "worktree", "add", "-q", "--detach", f.nested.cwd);
      await expect(prepareProjectRepositoryWorkspaces(f.preparation)).rejects.toThrow("Invalid project repository checkout path");
      await expect(assertReproducibleManagedCheckout(f.nested.cwd, { repoUrl: pathToFileURL(f.nestedRemote).href,
        resolveGitAuth: async () => null, baseCandidates: [f.sharedBase] })).rejects.toThrow("unproven_managed_checkout");
      expect(await f.expire({ expireBase: false })).toMatchObject({ expired: false, skipReason: "unproven_managed_checkout" });
      expect(git(f.sibling.cwd, "symbolic-ref", "HEAD")).toBe(ownBranch);
    });

    it("recovers process-abandoned nested worktree locks held in the shared base", async () => {
      const f = await nestedFixture(true, true);
      const locations = await crashWithExpirationLocks(f);
      const base = await real(f.sharedBase);
      const nestedLocks = locations.filter(location => location.checkout !== null);
      expect(nestedLocks.map(location => location.relativePath)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^\.git\/worktrees\/[^/]+\/index\.lock$/), expect.stringMatching(/^\.git\/refs\/heads\/paperclip\/[a-f0-9]{12}\/main\.lock$/)]));
      for (const location of nestedLocks) {
        expect(await real(location.root)).toBe(base);
        expect(await exists(path.join(location.root, location.relativePath))).toBe(true);
      }
      expect(await f.expire()).toMatchObject({ expired: true });
      for (const location of nestedLocks) expect(await exists(path.join(location.root, location.relativePath))).toBe(false);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(git(f.nested.cwd, "rev-parse", "HEAD")).toBe(f.nestedA);
      expect(git(f.nested.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(base, ".git"));
    });

    it("removes only the deleted task's nested worktrees and keeps its unpushed branch", async () => {
      const f = await sharedFixture();
      const { cleanupExecutionWorkspaceArtifacts } = await import("../services/workspace-runtime.js");
      const base = await real(f.sharedBase);
      git(f.nested.cwd, "commit", "-q", "--allow-empty", "-m", "Unpushed before deletion");
      const unpushed = git(f.nested.cwd, "rev-parse", "HEAD");
      const ownBranch = git(f.nested.cwd, "symbolic-ref", "HEAD");
      const siblingBranch = git(f.sibling.cwd, "symbolic-ref", "HEAD");
      const nestedPath = await real(f.nested.cwd);
      const row = await f.row();
      const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace: { ...row, providerType: "git_worktree", metadata: {} },
        runCleanupCommands: false });
      expect(cleanup).toMatchObject({ cleaned: true, warnings: [] });
      expect(await exists(f.cwd)).toBe(false);
      expect(await worktrees(base)).not.toContain(nestedPath);
      expect(await worktrees(base)).toContain(await real(f.sibling.cwd));
      expect(git(base, "rev-parse", ownBranch)).toBe(unpushed);
      const siblingPath = await real(f.sibling.cwd);
      const siblingWorkspace = { ...row, id: randomUUID(), cwd: f.siblingCwd, providerRef: f.siblingCwd, providerType: "local_fs",
        metadata: { createdByRuntime: true } };
      expect(await cleanupExecutionWorkspaceArtifacts({ workspace: siblingWorkspace, runCleanupCommands: false }))
        .toMatchObject({ cleaned: true, warnings: [] });
      expect(await worktrees(base)).not.toContain(siblingPath);
      expect(() => git(base, "rev-parse", "--verify", "-q", siblingBranch)).toThrow();
      expect(git(base, "rev-parse", ownBranch)).toBe(unpushed);
    });
  });

});
