import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, projects, projectWorkspaces, issues, executionWorkspaces, agents, heartbeatRuns, nativeRunFinalizations, workspaceRuntimeServices, executionWorkspaceRestorePoints, createDb } from "@paperclipai/db";
import { markGitRestorePointExpired } from "../services/git-restore-point-storage.js";
import { GIT_RESTORE_POINT_EXPIRED_WARNING } from "../services/execution-workspaces.js";
import { getStorageService } from "../storage/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.js";
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace, ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { prepareProjectRepositoryWorkspaces, mergeExecutionWorkspaceMetadataForPersistence } from "../services/heartbeat/workspaces.js";
import { expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import * as activityLog from "../services/activity-log.js";
import { readGitCacheRestoration } from "../services/git-workspace-restoration.js";
import { gitCacheExpirationLockLocations, readGitCacheExpiration } from "../services/git-workspace-restoration.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("reconstructable Git expiration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-cache-expiration-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
  });
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
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

  async function nestedFixture(managed = true) {
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
    const preparation = { cwd: f.cwd, anchorRepoUrl: f.base.repoUrl, workspaces: [source!], resolveGitAuth: async () => null };
    const [nested] = await prepareProjectRepositoryWorkspaces(preparation);
    const settings = Buffer.from('{"permissions":{"allow":["Read(/user/path)"]},"env":{"LOCAL_SETTING":"preserve-me"}}\n');
    const settingsPath = path.join(f.cwd, ".claude/settings.local.json");
    await fs.mkdir(path.dirname(settingsPath));
    await fs.writeFile(settingsPath, settings, { mode: 0o600 });
    const nestedSettingsPath = path.join(nested!.cwd, ".claude/settings.local.json");
    await fs.mkdir(path.dirname(nestedSettingsPath));
    await fs.writeFile(nestedSettingsPath, settings, { mode: 0o640 });
    return { ...f, nestedSource, nestedRemote, nestedA, preparation, nested: nested!, settings, settingsPath, nestedSettingsPath };
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
    const locations = gitCacheExpirationLockLocations(row);
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
    await db.insert(issues).values({ companyId: f.companyId, title: "Active child", status: "in_progress", parentId: f.issueId });
    expect((await f.expire()).expired).toBe(false);
    await db.delete(issues).where(eq(issues.parentId, f.issueId));
    const row = await f.row();
    await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, reopenPendingConsumption: true } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true);
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
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "terminal_failure", recoveryState: "blocked" });
    expect((await f.expire()).expired).toBe(false);
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      scopeType: "execution_workspace", serviceName: "Preview", status: "running", lifecycle: "persistent", provider: "local" });
    expect((await f.expire()).expired).toBe(false);
    expect(await exists(f.cwd)).toBe(true);
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

});
