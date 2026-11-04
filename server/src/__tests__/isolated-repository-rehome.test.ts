import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, applyPendingMigrations, companies, createDb, executionWorkspaceRestorePoints, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";
import { isolatedRemoteSourcePath, materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import { captureRestorePoint, currentRestorePointSnapshot } from "../services/git-restore-point.js";
import { rehomeIsolatedRepositoryWorkspace, sweepOrphanedIsolatedRepositorySources } from "../services/isolated-repository-rehome.js";
import { addNestedRepositoryWorktree, nestedRepositoryBaseCandidates, nestedWorktreeBranchPrefix, readLinkedNestedCheckout } from "../services/nested-repository-worktrees.js";
import { getStorageService } from "../storage/index.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const DAY_MS = 24 * 60 * 60 * 1000;

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISOLATED_REHOME_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("isolated repository source re-home", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("isolated-repository-rehome-");
    db = createDb(external ?? database!.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-rehome-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "41".repeat(32));
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await fs.rm(path.join(root, "home", "instances", "default", "isolated-repository-sources"), { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database?.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(options: { sharedBase?: boolean; issueStatus?: "in_progress" | "done" } = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
    const location = path.join(root, companyId), author = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    await fs.writeFile(path.join(author, "marker.txt"), "commit A\n");
    await fs.writeFile(path.join(author, "remove-me.txt"), "tracked\n");
    await fs.writeFile(path.join(author, ".gitignore"), "node_modules/\n.env\n.claude/settings.local.json\n*.tsbuildinfo\n");
    git(author, "add", "."); git(author, "commit", "-m", "A");
    git(location, "clone", "--bare", author, remote);
    const done = options.issueStatus === "done";
    await db.insert(companies).values({ id: companyId, name: "Re-home fixture", issuePrefix: `RH${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Open task", status: done ? "done" : "in_progress",
      ...(done ? { completedAt: new Date(Date.now() - 4 * DAY_MS) } : {}) });
    const repoUrl = pathToFileURL(remote).href;
    const sharedPath = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "remote" });
    if (options.sharedBase !== false) await materializeManagedProjectWorkspace(sharedPath, { repoUrl });
    const clone = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const realized = await realizeExecutionWorkspace({ base: { baseCwd: clone, source: "task_session", projectId: null, workspaceId: null, repoUrl, repoRef: "origin/main" },
      issue: { id: issueId, identifier: "RH-1", title: "Fixture" }, agent: { id: null, name: "Fixture", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "fixture-task", baseRef: "origin/main" } }, skipHostProvision: true });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "Fixture", status: "active", providerType: "local_fs", cwd: realized.cwd, providerRef: realized.cwd, repoUrl, baseRef: "origin/main",
      branchName: realized.branchName, metadata: { createdByRuntime: realized.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: realized.baseRefSha,
        isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const target = path.join(await fs.realpath(root), path.relative(root, sharedPath), ".paperclip", "worktrees", "fixture-task");
    return { companyId, issueId, workspaceId, projectId, cwd: realized.cwd, clone, sharedPath, target, repoUrl, remote, author, row };
  }

  async function makeWork(cwd: string) {
    await fs.writeFile(path.join(cwd, "marker.txt"), "commit B (unpushed)\n");
    git(cwd, "commit", "-am", "B unpushed");
    const unpushed = git(cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(cwd, "marker.txt"), "staged edit\n");
    git(cwd, "add", "marker.txt");
    await fs.writeFile(path.join(cwd, "marker.txt"), "unstaged edit\n");
    await fs.rm(path.join(cwd, "remove-me.txt"));
    await fs.mkdir(path.join(cwd, "notes"));
    await fs.writeFile(path.join(cwd, "notes", "todo.md"), "untracked work\n");
    await fs.chmod(path.join(cwd, "notes", "todo.md"), 0o600);
    await fs.writeFile(path.join(cwd, "build.tsbuildinfo"), "ignored output\n");
    await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(cwd, ".env"), "LOCAL_SETTING=1\n");
    await fs.mkdir(path.join(cwd, ".claude"));
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), "{\"local\":true}\n");
    return unpushed;
  }

  async function addLinkedNested(f: Awaited<ReturnType<typeof fixture>>) {
    const location = path.dirname(f.remote), author = path.join(location, "docs-author"), remote = path.join(location, "docs.git");
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    await fs.writeFile(path.join(author, "guide.md"), "guide\n"); git(author, "add", "."); git(author, "commit", "-m", "docs");
    git(location, "clone", "--bare", author, remote);
    const repoUrl = pathToFileURL(remote).href;
    const base = (await materializeManagedProjectWorkspace(nestedRepositoryBaseCandidates({ companyId: f.companyId, projectId: f.projectId, repoUrl })[0]!, { repoUrl })).cwd;
    await ensureManagedRepositoriesIgnored(f.cwd);
    const checkout = path.join(f.cwd, ".paperclip-repositories", "docs-linked");
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    const { branchName } = await addNestedRepositoryWorktree({ base, cwd: checkout, repoUrl, repoRef: null });
    await fs.writeFile(path.join(checkout, "guide.md"), "edited in the nested worktree\n");
    return { base, checkout, branchName, realBase: await fs.realpath(base) };
  }

  const worktreePaths = (base: string) => git(base, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));

  const gitView = (cwd: string) => ({ branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"), reflog: git(cwd, "reflog", "show", "--format=%H", "HEAD") });

  async function expectUntouched(f: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<typeof currentRestorePointSnapshot>>, cwd = f.cwd) {
    const current = await f.row();
    expect(current.cwd).toBe(f.cwd);
    expect(current.metadata?.isolatedRemoteSource).toBeDefined();
    expect(current.metadata?.isolatedRepositoryRehome).toBeUndefined();
    expect(await currentRestorePointSnapshot(cwd)).toEqual(before);
    expect(await exists(f.target)).toBe(false);
    if (await exists(f.sharedPath)) expect(() => git(f.sharedPath, "rev-parse", "--verify", "-q", "refs/heads/fixture-task")).toThrow();
  }

  it("re-homes an open workspace onto the shared project clone with its exact state", async () => {
    const f = await fixture();
    const unpushed = await makeWork(f.cwd);
    await ensureManagedRepositoriesIgnored(f.cwd);
    await fs.appendFile(path.join(f.cwd, ".gitignore"), "/.paperclip-repositories/\n");
    const nested = path.join(f.cwd, ".paperclip-repositories", "docs");
    await fs.mkdir(nested, { recursive: true });
    git(nested, "init", "--initial-branch=main");
    await fs.writeFile(path.join(nested, "readme.md"), "nested\n");
    await fs.writeFile(path.join(nested, ".gitignore"), "node_modules/\n"); git(nested, "add", "."); git(nested, "commit", "-m", "nested");
    await fs.mkdir(path.join(nested, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(nested, "node_modules", "dep", "index.js"), "nested dependency\n");
    const before = await currentRestorePointSnapshot(f.cwd);
    const view = gitView(f.cwd);

    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row());
    expect(result).toMatchObject({ outcome: "rehomed", rehomed: true, cloneRemoved: true, reason: null, cloneKeptReason: null, to: f.target });
    expect(result.reclaimedBytes).toBeGreaterThan(0);

    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);
    expect(gitView(f.target)).toEqual(view);
    expect(view.head).toBe(unpushed);
    expect(git(f.target, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(await fs.realpath(f.sharedPath), ".git"));
    expect(git(f.target, "show", ":marker.txt")).toBe("staged edit");
    expect(await fs.readFile(path.join(f.target, "marker.txt"), "utf8")).toBe("unstaged edit\n");
    expect(await exists(path.join(f.target, "remove-me.txt"))).toBe(false);
    expect((await fs.stat(path.join(f.target, "notes", "todo.md"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(f.target, "build.tsbuildinfo"), "utf8")).toBe("ignored output\n");
    expect(await fs.readFile(path.join(f.target, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await fs.readFile(path.join(f.target, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    expect(await fs.readFile(path.join(f.target, ".claude", "settings.local.json"), "utf8")).toBe("{\"local\":true}\n");
    expect(git(path.join(f.target, ".paperclip-repositories", "docs"), "log", "-1", "--format=%s")).toBe("nested");
    expect(await fs.readFile(path.join(f.target, ".paperclip-repositories", "docs", "node_modules", "dep", "index.js"), "utf8")).toBe("nested dependency\n");

    const row = await f.row();
    expect(row).toMatchObject({ cwd: f.target, providerRef: f.target, branchName: "fixture-task" });
    expect(row.metadata?.isolatedRemoteSource).toBeUndefined();
    expect(row.metadata?.isolatedRepositoryRehome).toMatchObject({ from: f.cwd, to: f.target, cleanedAt: expect.any(String) });
    expect(await exists(f.cwd)).toBe(false);
    expect(await exists(f.clone)).toBe(false);
    expect(await exists(isolatedRemoteSourcePath(f.companyId, f.issueId))).toBe(false);
    expect(await rehomeIsolatedRepositoryWorkspace(db, row)).toMatchObject({ rehomed: false, reason: "not_candidate" });
  });

  it("moves worktree-backed nested checkouts and repairs their registration in their shared clone", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const nested = await addLinkedNested(f);
    const oldCheckout = await fs.realpath(nested.checkout);
    const previousPrefix = await nestedWorktreeBranchPrefix(oldCheckout);
    const before = await currentRestorePointSnapshot(f.cwd);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row());
    expect(result).toMatchObject({ rehomed: true, cloneRemoved: true, reason: null });
    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);
    const moved = path.join(f.target, ".paperclip-repositories", "docs-linked");
    expect(await readLinkedNestedCheckout(moved)).toMatchObject({ base: nested.realBase, checkout: moved });
    expect(worktreePaths(nested.base)).toContain(moved);
    expect(worktreePaths(nested.base)).not.toContain(oldCheckout);
    expect(nested.branchName!.startsWith(previousPrefix)).toBe(true);
    const renamed = `${await nestedWorktreeBranchPrefix(moved)}${nested.branchName!.slice(previousPrefix.length)}`;
    expect(renamed).not.toBe(nested.branchName);
    expect(git(moved, "symbolic-ref", "--short", "HEAD")).toBe(renamed);
    expect(() => git(nested.base, "rev-parse", "--verify", "-q", `refs/heads/${nested.branchName}`)).toThrow();
    expect(git(moved, "status", "--porcelain")).toBe("M guide.md");
    expect(git(nested.base, "worktree", "list", "--porcelain")).not.toContain("prunable");
  });

  it("restores the registration of worktree-backed nested checkouts when a move rolls back", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const nested = await addLinkedNested(f);
    const oldCheckout = await fs.realpath(nested.checkout);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { beforeVerify: async ({ from, to }) => {
      expect(worktreePaths(nested.base)).toContain(path.join(to, ".paperclip-repositories", "docs-linked"));
      await fs.writeFile(path.join(from, "late.txt"), "written by a concurrent run\n");
    } } });
    expect(result).toMatchObject({ rehomed: false, reason: "snapshot_mismatch" });
    expect(await readLinkedNestedCheckout(nested.checkout)).toMatchObject({ base: nested.realBase, checkout: oldCheckout });
    expect(worktreePaths(nested.base)).toContain(oldCheckout);
    expect(git(nested.checkout, "symbolic-ref", "--short", "HEAD")).toBe(nested.branchName);
    expect(git(nested.checkout, "status", "--porcelain")).toBe("M guide.md");
    expect(await exists(f.target)).toBe(false);
  });

  it("keeps a workspace with a live run", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Fixture", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId, issueId: f.issueId, status: "running" });
    const before = await currentRestorePointSnapshot(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: false, reason: "live_or_unresolved_consumer" });
    await expectUntouched(f, before);
  });

  it("keeps a workspace whose branch already exists in the shared clone at an unrelated commit", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const foreign = git(f.sharedPath, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "foreign");
    git(f.sharedPath, "update-ref", "refs/heads/fixture-task", foreign);
    const before = await currentRestorePointSnapshot(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: false, reason: "base_branch_diverged" });
    expect(git(f.sharedPath, "rev-parse", "refs/heads/fixture-task")).toBe(foreign);
    git(f.sharedPath, "update-ref", "-d", "refs/heads/fixture-task");
    await expectUntouched(f, before);
  });

  it("keeps a workspace when the project has no shared clone", async () => {
    const f = await fixture({ sharedBase: false });
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: false, reason: "no_shared_base" });
    await expectUntouched(f, before);
  });

  it("keeps a workspace with state a restore point cannot transfer", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const nested = path.join(f.cwd, "vendor-checkout");
    await fs.mkdir(nested);
    git(nested, "init", "--initial-branch=main");
    const view = gitView(f.cwd);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row());
    expect(result).toMatchObject({ rehomed: false, reason: "untracked_nested_repository" });
    expect(gitView(f.cwd)).toEqual(view);
    expect(await exists(path.join(f.cwd, "node_modules", "pkg", "index.js"))).toBe(true);
    await fs.rm(nested, { recursive: true });
    await expectUntouched(f, await currentRestorePointSnapshot(f.cwd));
  });

  it("removes the new worktree and keeps the old one when the workspace changes during the move", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { beforeVerify: async ({ from, to }) => {
      expect(await exists(path.join(to, "node_modules"))).toBe(true);
      await fs.writeFile(path.join(from, "late.txt"), "written by a concurrent run\n");
    } } });
    expect(result).toMatchObject({ rehomed: false, reason: "snapshot_mismatch" });
    await fs.rm(path.join(f.cwd, "late.txt"));
    await expectUntouched(f, before);
    expect(await fs.readFile(path.join(f.cwd, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    expect(await fs.readFile(path.join(f.cwd, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(git(f.sharedPath, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
  });

  it("undoes a move interrupted before the database update and then completes it", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    const from = await fs.realpath(f.cwd);
    const head = git(f.cwd, "rev-parse", "HEAD");
    git(f.sharedPath, "fetch", "-q", f.clone, "refs/heads/fixture-task:refs/heads/fixture-task");
    git(f.sharedPath, "worktree", "add", "-q", f.target, "fixture-task");
    await fs.rename(path.join(f.cwd, "node_modules"), path.join(f.target, "node_modules"));
    await fs.rename(path.join(f.cwd, ".env"), path.join(f.target, ".env"));
    const pending = { base: f.sharedPath, from, target: f.target, branch: "fixture-task", head, previousTip: null, moves: [".env", "node_modules"] };
    const current = await f.row();
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, isolatedRepositoryRehomePending: pending } }).where(eq(executionWorkspaces.id, f.workspaceId));

    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { dryRun: true }))
      .toMatchObject({ outcome: "dry_run", rehomed: false, reason: "interrupted_rehome_pending" });
    expect(await exists(path.join(f.target, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(await exists(path.join(f.cwd, ".env"))).toBe(false);
    expect(git(f.sharedPath, "rev-parse", "refs/heads/fixture-task")).toBe(head);
    expect((await f.row()).metadata?.isolatedRepositoryRehomePending).toEqual(pending);

    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row());
    expect(result).toMatchObject({ rehomed: true, cloneRemoved: true, reason: null });
    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);
    expect(await fs.readFile(path.join(f.target, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    expect(await fs.readFile(path.join(f.target, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect((await f.row()).metadata?.isolatedRepositoryRehomePending).toBeUndefined();
  });

  it("never deletes a target worktree another workspace created during the move", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { beforeWorktreeAdd: async ({ to }) => {
      await fs.mkdir(to, { recursive: true });
      await fs.writeFile(path.join(to, "other.txt"), "another workspace\n");
    } } });
    expect(result).toMatchObject({ rehomed: false, reason: "target_worktree_exists" });
    expect(await fs.readFile(path.join(f.target, "other.txt"), "utf8")).toBe("another workspace\n");
    await fs.rm(f.target, { recursive: true });
    await expectUntouched(f, before);
    expect((await f.row()).metadata?.isolatedRepositoryRehomePending).toBeUndefined();
  });

  it("keeps both copies when a file reappears in the old worktree before verification", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { beforeVerify: async ({ from }) => {
      await fs.writeFile(path.join(from, ".env"), "RECREATED=1\n");
    } } });
    expect(result).toMatchObject({ rehomed: false, reason: "rehome_rollback_conflict" });
    expect(await fs.readFile(path.join(f.target, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    expect(await fs.readFile(path.join(f.cwd, ".env"), "utf8")).toBe("RECREATED=1\n");
    expect((await f.row()).metadata?.isolatedRepositoryRehomePending).toMatchObject({ target: f.target });
    expect((await f.row()).cwd).toBe(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: false, reason: "rehome_rollback_conflict" });
    expect(await fs.readFile(path.join(f.target, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    await fs.rm(path.join(f.cwd, ".env"));
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: true, reason: null });
    expect(await fs.readFile(path.join(f.target, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
  });

  it("refuses to check out from a shared clone whose config runs filters", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const marker = path.join(path.dirname(f.remote), "smudge-ran");
    git(f.sharedPath, "config", "filter.evil.smudge", `sh -c 'touch ${marker}; cat'`);
    git(f.sharedPath, "config", "filter.evil.required", "true");
    const before = await currentRestorePointSnapshot(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: false, reason: "unsupported_base_git_config" });
    expect(await exists(marker)).toBe(false);
    await expectUntouched(f, before);
  });

  it("keeps a clone with more refs than the cleanup budget", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { afterDatabaseUpdate: async () => { throw new Error("simulated crash"); } } });
    const head = git(f.clone, "rev-parse", "HEAD");
    execFileSync("git", ["-C", f.clone, "update-ref", "--stdin"], { input: Array.from({ length: 5_001 }, (_, index) => `create refs/tags/extra-${index} ${head}`).join("\n") + "\n" });
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "clone_history_budget" });
    expect(await exists(f.clone)).toBe(true);
    expect((await f.row()).metadata?.isolatedRepositoryRehome).toMatchObject({ cleanedAt: null });
    execFileSync("git", ["-C", f.clone, "update-ref", "--stdin"], { input: Array.from({ length: 5_001 }, (_, index) => `delete refs/tags/extra-${index}`).join("\n") + "\n" });
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ outcome: "cleaned", cloneRemoved: true });
  });

  it("keeps the clone while another workspace still references it", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId, sourceIssueId: f.issueId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Sibling", status: "active", providerType: "local_fs", cwd: path.join(f.clone, "sibling"), repoUrl: f.repoUrl,
      metadata: { isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId: f.companyId, issueId: f.issueId, repoUrl: f.repoUrl } } });
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row());
    expect(result).toMatchObject({ rehomed: true, cloneRemoved: false, cloneKeptReason: "base_has_consumers" });
    expect(await exists(f.clone)).toBe(true);
    expect(await exists(f.cwd)).toBe(false);
    expect((await f.row()).metadata?.isolatedRepositoryRehome).toMatchObject({ cloneRetained: "base_has_consumers", cleanedAt: expect.any(String) });
  });

  it("finishes removing the clone on a later sweep after a crash following the database update", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    const crashed = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { afterDatabaseUpdate: async () => { throw new Error("simulated crash"); } } });
    expect(crashed).toMatchObject({ rehomed: true, cloneRemoved: false });
    expect(await f.row()).toMatchObject({ cwd: f.target, metadata: expect.objectContaining({ isolatedRepositoryRehome: expect.objectContaining({ cleanedAt: null }) }) });
    expect(await exists(f.clone)).toBe(true);
    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);

    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, f.workspaceId));
    const service = executionWorkspaceService(db, { gitCacheExpirationEnabled: true, isolatedSourceRehomeEnabled: true });
    await service.sweepTerminalWorkspaces();
    expect(await exists(f.clone)).toBe(false);
    expect(await exists(f.cwd)).toBe(false);
    expect((await f.row()).metadata?.isolatedRepositoryRehome).toMatchObject({ cleanedAt: expect.any(String) });
    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);
    expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();
  });

  it("is disabled by default and changes nothing in dry run", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const before = await currentRestorePointSnapshot(f.cwd);
    await executionWorkspaceService(db, { gitCacheExpirationEnabled: true }).sweepTerminalWorkspaces();
    await executionWorkspaceService(db, { isolatedSourceRehomeEnabled: true }).sweepTerminalWorkspaces();
    await expectUntouched(f, before);
    let tick = Date.now();
    const dryRun = executionWorkspaceService(db, { gitCacheExpirationEnabled: true, isolatedSourceRehomeEnabled: true,
      isolatedSourceRehomeDryRun: true, now: () => new Date(tick++) });
    await dryRun.sweepTerminalWorkspaces();
    await expectUntouched(f, before);
    expect(await exists(f.clone)).toBe(true);
    const retryAt = await dryRun.nextTerminalWorkspaceSweepAt();
    expect(retryAt).toBeGreaterThan(Date.now());
    await dryRun.sweepTerminalWorkspaces();
    expect(await dryRun.nextTerminalWorkspaceSweepAt()).toBe(retryAt);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { dryRun: true })).toMatchObject({ outcome: "dry_run", rehomed: false, to: f.target });
    await expectUntouched(f, before);
  });

  it("restores an expired isolated workspace into the shared project clone without recreating its clone", async () => {
    const f = await fixture({ issueStatus: "done" });
    const unpushed = await makeWork(f.cwd);
    await fs.rm(path.join(f.cwd, "node_modules"), { recursive: true });
    const expired = await expireReconstructableGitWorkspace(db, await f.row(), { dryRun: false, expireBase: true, now: new Date(),
      restorePoint: { storage: getStorageService(), notBefore: new Date(Date.now() - DAY_MS), keyDurable: true } });
    expect(expired).toMatchObject({ expired: true, restorePoint: true });
    await fs.rm(f.clone, { recursive: true, force: true });

    const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspaceId,
      issue: { id: f.issueId, companyId: f.companyId, projectId: f.projectId }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    expect(reopened).toMatchObject({ ok: true, reopened: true });
    expect(await exists(f.clone)).toBe(false);
    const row = await f.row();
    expect(row).toMatchObject({ status: "active", cwd: f.target, providerRef: f.target });
    expect(row.metadata?.isolatedRemoteSource).toBeUndefined();
    expect(row.metadata?.gitCacheRestoration).toMatchObject({ sourceKind: "managed_project", sourcePath: f.sharedPath, worktreePath: f.target,
      restorePoint: { appliedAt: expect.any(String) } });
    expect(git(f.target, "rev-parse", "HEAD")).toBe(unpushed);
    expect(git(f.target, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(await fs.realpath(f.sharedPath), ".git"));
    expect(git(f.target, "show", ":marker.txt")).toBe("staged edit");
    expect(await fs.readFile(path.join(f.target, "marker.txt"), "utf8")).toBe("unstaged edit\n");
    expect(await fs.readFile(path.join(f.target, "notes", "todo.md"), "utf8")).toBe("untracked work\n");
    expect(await fs.readFile(path.join(f.target, "build.tsbuildinfo"), "utf8")).toBe("ignored output\n");
  });

  it("restores through the private clone when the shared clone lacks the restore point's base commits", async () => {
    const f = await fixture({ issueStatus: "done" });
    await fs.writeFile(path.join(f.author, "marker.txt"), "commit C\n");
    git(f.author, "commit", "-qam", "C");
    git(f.author, "push", "-q", f.remote, "main");
    const upstream = git(f.author, "rev-parse", "HEAD");
    git(f.cwd, "fetch", "-q", "origin");
    git(f.cwd, "reset", "-q", "--hard", "origin/main");
    await fs.writeFile(path.join(f.cwd, "marker.txt"), "commit D (unpushed)\n");
    git(f.cwd, "commit", "-qam", "D unpushed");
    const unpushed = git(f.cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.cwd, "notes.txt"), "untracked work\n");
    const expired = await expireReconstructableGitWorkspace(db, await f.row(), { dryRun: false, expireBase: true, now: new Date(),
      restorePoint: { storage: getStorageService(), notBefore: new Date(Date.now() - DAY_MS), keyDurable: true } });
    expect(expired).toMatchObject({ expired: true, restorePoint: true });
    await fs.rm(f.clone, { recursive: true, force: true });
    expect(() => git(f.sharedPath, "cat-file", "-e", `${upstream}^{commit}`)).toThrow();

    const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspaceId,
      issue: { id: f.issueId, companyId: f.companyId, projectId: f.projectId }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    expect(reopened).toMatchObject({ ok: true, reopened: true });
    const row = await f.row();
    expect(row.cwd).toBe(f.cwd);
    expect(row.metadata?.isolatedRemoteSource).toBeDefined();
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await fs.readFile(path.join(f.cwd, "notes.txt"), "utf8")).toBe("untracked work\n");
  });

  async function crashedRehome(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await rehomeIsolatedRepositoryWorkspace(db, await f.row(), { hooks: { afterDatabaseUpdate: async () => { throw new Error("simulated crash"); } } });
    expect(result).toMatchObject({ rehomed: true, cloneRemoved: false });
    return result;
  }

  async function publishUnfetchedHistory(f: Awaited<ReturnType<typeof fixture>>) {
    git(f.author, "checkout", "-q", "-b", "feature");
    await fs.writeFile(path.join(f.author, "feature.txt"), "feature\n"); git(f.author, "add", "."); git(f.author, "commit", "-qm", "feature");
    const feature = git(f.author, "rev-parse", "HEAD");
    git(f.author, "checkout", "-q", "main");
    const release = git(f.author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "release");
    git(f.author, "tag", "v1", release);
    git(f.author, "push", "-q", f.remote, "feature", "v1");
    git(f.clone, "fetch", "-q", "--tags", "origin");
    return { feature, release };
  }

  it("deletes a clean clone whose only extra history is remote branches and tags the shared clone never fetched", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const { feature, release } = await publishUnfetchedHistory(f);
    await fs.appendFile(path.join(f.clone, ".git", "info", "exclude"), "\n.paperclip/\n");
    await crashedRehome(f);
    expect(() => git(f.sharedPath, "cat-file", "-e", `${release}^{commit}`)).toThrow();
    expect(() => git(f.sharedPath, "cat-file", "-e", `${feature}^{commit}`)).toThrow();
    expect(git(f.clone, "rev-parse", "refs/tags/v1")).toBe(release);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ outcome: "cleaned", cloneRemoved: true, cloneKeptReason: null });
    expect(await exists(f.clone)).toBe(false);
  });

  it("keeps a clone with a local branch commit that is neither upstream nor in the shared clone", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    const local = git(f.clone, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "local only");
    git(f.clone, "branch", "local-work", local);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "unique_clone_history", cloneKeptPaths: [local] });
    expect(await exists(f.clone)).toBe(true);
    expect((await f.row()).metadata?.isolatedRepositoryRehome).toMatchObject({ cleanedAt: null });
  });

  it("keeps a clone whose detached HEAD holds the only copy of a commit", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    const detached = git(f.clone, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "detached only");
    git(f.clone, "checkout", "-q", "--detach", detached);
    git(f.clone, "reflog", "expire", "--expire=now", "--all");
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "unique_clone_history", cloneKeptPaths: [detached] });
    expect(await exists(f.clone)).toBe(true);
  });

  it("keeps a clone whose own checkout has changes or unexplained ignored files", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    await fs.writeFile(path.join(f.clone, "marker.txt"), "edited in the clone\n");
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "clone_checkout_has_files", cloneKeptPaths: ["marker.txt"] });
    git(f.clone, "checkout", "--", "marker.txt");
    await fs.writeFile(path.join(f.clone, "cache.tsbuildinfo"), "ignored but not regenerable\n");
    await fs.mkdir(path.join(f.clone, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(f.clone, "node_modules", "dep", "index.js"), "regenerable\n");
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "clone_checkout_has_files", cloneKeptPaths: ["cache.tsbuildinfo"] });
    await fs.rm(path.join(f.clone, "cache.tsbuildinfo"));
    await fs.mkdir(path.join(f.clone, "build"));
    await fs.writeFile(path.join(f.clone, "build", "notes.txt"), "untracked, not ignored\n");
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "clone_checkout_has_files", cloneKeptPaths: ["build/"] });
    await fs.rm(path.join(f.clone, "build"), { recursive: true });
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ outcome: "cleaned", cloneRemoved: true });
  });

  it("keeps a clone with another registered worktree", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    const extra = path.join(path.dirname(f.remote), "extra-worktree");
    git(f.clone, "worktree", "add", "-q", "-b", "extra", extra);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "base_has_worktrees" });
    expect(await exists(f.clone)).toBe(true);
  });

  it("removes the old worktree and clone when the old worktree's registration was already pruned", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    await fs.rm(path.join(f.clone, ".git", "worktrees", "fixture-task"), { recursive: true });
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ outcome: "cleaned", cloneRemoved: true, cloneKeptReason: null });
    expect(await exists(f.cwd)).toBe(false);
  });

  it("sweeps orphaned clones that no workspace needs and keeps those with unique history", async () => {
    const orphan = await fixture();
    await makeWork(orphan.cwd);
    await publishUnfetchedHistory(orphan);
    await crashedRehome(orphan);
    git(orphan.clone, "worktree", "remove", "--force", orphan.cwd);
    const current = await orphan.row();
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, isolatedRepositoryRehome: {
      ...current.metadata?.isolatedRepositoryRehome as Record<string, unknown>, cleanedAt: new Date().toISOString() } } }).where(eq(executionWorkspaces.id, orphan.workspaceId));
    const unknown = await fixture();
    await makeWork(unknown.cwd);
    await crashedRehome(unknown);
    git(unknown.clone, "worktree", "remove", "--force", unknown.cwd);
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, unknown.workspaceId));

    const first = await sweepOrphanedIsolatedRepositorySources(db, { dryRun: true, limit: 1 });
    expect(first.results).toHaveLength(1);
    expect(first.next).toEqual(expect.any(String));
    const second = await sweepOrphanedIsolatedRepositorySources(db, { dryRun: true, limit: 1, after: first.next });
    expect(second).toMatchObject({ results: [expect.anything()], next: null });
    expect(new Set([...first.results, ...second.results].map(result => result.issueId))).toEqual(new Set([orphan.issueId, unknown.issueId]));
    const dryRun = executionWorkspaceService(db, { gitCacheExpirationEnabled: true, isolatedSourceRehomeEnabled: true, isolatedSourceRehomeDryRun: true });
    await dryRun.sweepTerminalWorkspaces();
    expect(await exists(orphan.clone)).toBe(true);

    const service = executionWorkspaceService(db, { gitCacheExpirationEnabled: true, isolatedSourceRehomeEnabled: true });
    await service.sweepTerminalWorkspaces();
    expect(await exists(orphan.clone)).toBe(false);
    expect(await exists(unknown.clone)).toBe(true);
    expect(await service.nextTerminalWorkspaceSweepAt()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("re-homes a workspace whose changes exceed the default restore point limits", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    const large = Buffer.alloc(65 * 1024 * 1024, 7);
    await fs.writeFile(path.join(f.cwd, "notes", "large.bin"), large);
    await fs.writeFile(path.join(f.cwd, "large.tsbuildinfo"), large);
    await expect(captureRestorePoint({ cwd: f.cwd, upstreamCommits: [] })).rejects.toMatchObject({ reason: "restore_point_too_large" });
    const before = await currentRestorePointSnapshot(f.cwd);
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ rehomed: true, cloneRemoved: true, reason: null });
    expect(await currentRestorePointSnapshot(f.target)).toEqual(before);
    expect((await fs.readFile(path.join(f.target, "notes", "large.bin"))).equals(large)).toBe(true);
    expect((await fs.readFile(path.join(f.target, "large.tsbuildinfo"))).equals(large)).toBe(true);
  });

  it("keeps an orphaned clone whose origin no longer matches the recorded repository", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    git(f.clone, "worktree", "remove", "--force", f.cwd);
    const current = await f.row();
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, isolatedRepositoryRehome: {
      ...current.metadata?.isolatedRepositoryRehome as Record<string, unknown>, cleanedAt: new Date().toISOString() } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const decoy = path.join(path.dirname(f.remote), "decoy.git");
    git(path.dirname(f.remote), "clone", "-q", "--bare", f.clone, decoy);
    git(f.clone, "remote", "set-url", "origin", pathToFileURL(decoy).href);
    const { results } = await sweepOrphanedIsolatedRepositorySources(db);
    expect(results).toMatchObject([{ issueId: f.issueId, removed: false, reason: "source_identity_changed" }]);
    expect(await exists(f.clone)).toBe(true);
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await sweepOrphanedIsolatedRepositorySources(db)).results).toMatchObject([{ issueId: f.issueId, removed: false, reason: "unproven_repository" }]);
  });

  it("keeps a clone with more ignored directories than the cleanup budget", async () => {
    const f = await fixture();
    await makeWork(f.cwd);
    await crashedRehome(f);
    await fs.appendFile(path.join(f.clone, ".git", "info", "exclude"), "\nscratch-*/\n");
    for (let index = 0; index <= 1_000; index += 1) {
      await fs.mkdir(path.join(f.clone, `scratch-${index}`, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(f.clone, `scratch-${index}`, "node_modules", "x.js"), "x\n");
    }
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ cloneRemoved: false, cloneKeptReason: "clone_file_budget" });
    for (let index = 1; index <= 1_000; index += 1) await fs.rm(path.join(f.clone, `scratch-${index}`), { recursive: true });
    expect(await rehomeIsolatedRepositoryWorkspace(db, await f.row())).toMatchObject({ outcome: "cleaned", cloneRemoved: true });
  });
});
