import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, applyPendingMigrations, companies, createDb, executionWorkspaceRestorePoints, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.js";
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { prepareProjectRepositoryWorkspaces } from "../services/heartbeat/workspaces.js";
import { expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import { currentRestorePointSnapshot, restorePointHistoryDigest } from "../services/git-restore-point.js";
import { nestedRepositoryBaseCandidates, nestedWorktreeBranchPrefix, readLinkedNestedCheckout, withNestedRepositoryBaseLock } from "../services/nested-repository-worktrees.js";
import { listNestedCloneMigrationNames, migrateNestedRepositoryClone, nextNestedCloneMigrationBatch, type NestedCloneMigrationOptions } from "../services/nested-clone-migration.js";
import { getStorageService } from "../storage/index.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const DAY_MS = 24 * 60 * 60 * 1000;
const noAuth = async () => null;

describe("nested clone migration batches", () => {
  it("puts pending recoveries first, rotates through the rest and stops retrying an exhausted rotation until the list changes", () => {
    const listed = Array.from({ length: 10 }, (_, index) => `repo-${index.toString(16).padStart(12, "0")}`);
    const first = nextNestedCloneMigrationBatch(listed, [listed[9]!], undefined, 4);
    expect(first).toMatchObject({ names: [listed[9], listed[0], listed[1], listed[2]], overflow: true, retryOverflow: true });
    const second = nextNestedCloneMigrationBatch(listed, [], first.rotation, 4);
    expect(second).toMatchObject({ names: [listed[3], listed[4], listed[5], listed[6]], retryOverflow: true });
    const third = nextNestedCloneMigrationBatch(listed, [], second.rotation, 4);
    expect(third).toMatchObject({ names: [listed[7], listed[8], listed[0], listed[1]], retryOverflow: false });
    expect([...third.rotation.visited]).toEqual([]);
    const fourth = nextNestedCloneMigrationBatch(listed, [], third.rotation, 4);
    expect(fourth).toMatchObject({ names: listed.slice(0, 4), retryOverflow: false });
    const grown = [...listed, "repo-aaaaaaaaaaaa"];
    expect(nextNestedCloneMigrationBatch(grown, [], fourth.rotation, 4)).toMatchObject({ retryOverflow: true });
    expect(nextNestedCloneMigrationBatch(listed.slice(0, 3), [], undefined, 4)).toMatchObject({ names: listed.slice(0, 3), overflow: false, retryOverflow: false });
  });
});

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NESTED_CLONE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("nested repository clone migration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("nested-clone-migration-");
    db = createDb(external ?? database!.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-nested-migration-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database?.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function repository(location: string, name: string, files: Record<string, string>) {
    const author = path.join(location, `${name}-author`), remote = path.join(location, `${name}.git`);
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    for (const [file, contents] of Object.entries(files)) await fs.writeFile(path.join(author, file), contents);
    git(author, "add", "."); git(author, "commit", "-m", `${name} A`);
    git(location, "clone", "--bare", author, remote);
    return { author, remote, url: pathToFileURL(remote).href, commit: git(author, "rev-parse", "HEAD") };
  }

  async function fixture(options: { issueStatus?: "in_progress" | "done"; sharedBase?: boolean } = {}) {
    const companyId = randomUUID(), projectId = randomUUID();
    const location = path.join(root, companyId);
    const main = await repository(location, "remote", { "marker.txt": "commit A\n", ".gitignore": "node_modules/\n.claude/settings.local.json\n" });
    const nested = await repository(location, "nested", { "nested.txt": "nested A\n", "remove-me.txt": "tracked\n",
      ".gitignore": "node_modules/\n.env\n.claude/settings.local.json\n*.log\n" });
    await db.insert(companies).values({ id: companyId, name: "Nested migration fixture", issuePrefix: `NM${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture project" });
    const [source] = await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Nested repository", repoUrl: nested.url, repoRef: "main" }).returning();
    const candidates = nestedRepositoryBaseCandidates({ companyId, projectId, repoUrl: nested.url });
    if (options.sharedBase !== false) await materializeManagedProjectWorkspace(candidates[0]!, { repoUrl: nested.url });
    const done = options.issueStatus === "done";
    const task = async (label: string) => {
      const issueId = randomUUID(), workspaceId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: `Task ${label}`, status: done ? "done" : "in_progress",
        ...(done ? { completedAt: new Date(Date.now() - 2 * DAY_MS) } : {}) });
      const baseCwd = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl: main.url, resolveGitAuth: noAuth });
      const base = { baseCwd, source: "task_session" as const, projectId: null, workspaceId: null, repoUrl: main.url, repoRef: "origin/main" };
      const realized = await realizeExecutionWorkspace({ base, issue: { id: issueId, identifier: `NM-${label}`, title: "Fixture" },
        agent: { id: null, name: "Fixture", companyId }, skipHostProvision: true,
        config: { workspaceStrategy: { type: "git_worktree", branchTemplate: `task-${label}`, worktreeParentDir: path.join(baseCwd, ".paperclip", "worktrees"), baseRef: "origin/main" } } });
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: `Task ${label}`, status: "active", providerType: "local_fs", cwd: realized.cwd, providerRef: realized.cwd,
        repoUrl: main.url, baseRef: "origin/main", branchName: realized.branchName,
        metadata: { createdByRuntime: realized.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: realized.baseRefSha,
          isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl: main.url } } });
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
      const [prepared] = await prepareProjectRepositoryWorkspaces({ cwd: realized.cwd, anchorRepoUrl: main.url, workspaces: [source!], resolveGitAuth: noAuth });
      const checkout = await fs.realpath(prepared!.cwd);
      const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
      const migrate = async (migrationOptions: NestedCloneMigrationOptions = {}) =>
        migrateNestedRepositoryClone(db, await row(), path.basename(checkout), { resolveGitAuth: noAuth, ...migrationOptions });
      const expire = async () => expireReconstructableGitWorkspace(db, await row(), { dryRun: false, expireBase: false, now: new Date(),
        restorePoint: { storage: getStorageService(), notBefore: new Date(Date.now() - DAY_MS), keyDurable: true } });
      const reopen = () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId,
        issue: { id: issueId, companyId, projectId: null }, actor: { actorType: "user", agentId: null },
        authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
      return { issueId, workspaceId, cwd: realized.cwd, checkout, name: path.basename(checkout), prefix: await nestedWorktreeBranchPrefix(checkout),
        row, migrate, expire, reopen };
    };
    const first = await task("one");
    return { companyId, projectId, main, nested, candidates, base: candidates[0]!, task, ...first };
  }

  async function nestedWork(checkout: string) {
    await fs.writeFile(path.join(checkout, "nested.txt"), "nested B (unpushed)\n");
    git(checkout, "commit", "-qam", "Nested B unpushed");
    const unpushed = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "-q", "-b", "side");
    await fs.writeFile(path.join(checkout, "side.txt"), "side branch work\n");
    git(checkout, "add", "side.txt"); git(checkout, "commit", "-qm", "Side work");
    const side = git(checkout, "rev-parse", "HEAD");
    git(checkout, "tag", "local-tag");
    git(checkout, "checkout", "-q", "main");
    git(checkout, "tag", "-a", "-m", "annotated local release", "local-release");
    await fs.writeFile(path.join(checkout, "nested.txt"), "staged edit\n");
    git(checkout, "add", "nested.txt");
    await fs.writeFile(path.join(checkout, "nested.txt"), "unstaged edit\n");
    await fs.rm(path.join(checkout, "remove-me.txt"));
    await fs.writeFile(path.join(checkout, "draft.md"), "untracked work\n");
    await fs.chmod(path.join(checkout, "draft.md"), 0o600);
    await fs.writeFile(path.join(checkout, "build.log"), "ignored output\n");
    await fs.mkdir(path.join(checkout, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(checkout, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(checkout, ".env"), "LOCAL_SETTING=1\n");
    await fs.mkdir(path.join(checkout, ".claude"));
    await fs.writeFile(path.join(checkout, ".claude", "settings.local.json"), "{\"local\":true}\n");
    return { unpushed, side };
  }

  const gitView = (cwd: string) => ({ head: git(cwd, "rev-parse", "HEAD"), status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
    reflog: git(cwd, "reflog", "show", "--format=%H", "HEAD"), staged: git(cwd, "show", ":nested.txt") });
  const ownedRefs = (base: string, prefix: string) => git(base, "for-each-ref", "--format=%(refname) %(objectname)", `refs/heads/${prefix}`);
  const worktreePaths = (base: string) => git(base, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
  const staging = (checkout: string) => [".clone-migrating", ".clone-standalone", ".clone-trash"].map(suffix => `${checkout}${suffix}`);

  async function expectUntouched(f: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<typeof currentRestorePointSnapshot>>, checkout = f.checkout, prefix = f.prefix) {
    expect((await fs.lstat(path.join(checkout, ".git"))).isDirectory()).toBe(true);
    expect(await currentRestorePointSnapshot(checkout)).toEqual(before);
    for (const target of staging(checkout)) expect(await exists(target)).toBe(false);
    expect(ownedRefs(f.base, prefix)).toBe("");
    expect(worktreePaths(f.base)).toHaveLength(1);
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
  }

  it("converts a standalone nested clone into a worktree of the shared clone with its exact state and history", async () => {
    const f = await fixture();
    const { unpushed, side } = await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    const view = gitView(f.checkout);
    const realBase = await fs.realpath(f.base);
    expect(await listNestedCloneMigrationNames(db, await f.row())).toEqual([f.name]);

    const result = await f.migrate();
    expect(result).toMatchObject({ outcome: "migrated", reason: null, branchName: `${f.prefix}main` });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.candidateBytes).toBeGreaterThan(0);

    expect((await fs.lstat(path.join(f.checkout, ".git"))).isFile()).toBe(true);
    expect(git(f.checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(realBase, ".git"));
    expect(await readLinkedNestedCheckout(f.checkout)).toMatchObject({ base: realBase, checkout: f.checkout });
    expect(worktreePaths(f.base)).toContain(f.checkout);
    expect(await currentRestorePointSnapshot(f.checkout)).toEqual(before);
    expect(gitView(f.checkout)).toEqual(view);
    expect(view.head).toBe(unpushed);
    expect(git(f.checkout, "symbolic-ref", "--short", "HEAD")).toBe(`${f.prefix}main`);
    expect(git(f.checkout, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    expect(await fs.readFile(path.join(f.checkout, "nested.txt"), "utf8")).toBe("unstaged edit\n");
    expect(await exists(path.join(f.checkout, "remove-me.txt"))).toBe(false);
    expect((await fs.stat(path.join(f.checkout, "draft.md"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(f.checkout, "build.log"), "utf8")).toBe("ignored output\n");
    expect(await fs.readFile(path.join(f.checkout, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await fs.readFile(path.join(f.checkout, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
    expect(await fs.readFile(path.join(f.checkout, ".claude", "settings.local.json"), "utf8")).toBe("{\"local\":true}\n");

    expect(git(f.base, "rev-parse", `refs/heads/${f.prefix}main`)).toBe(unpushed);
    expect(git(f.base, "rev-parse", `refs/heads/${f.prefix}side`)).toBe(side);
    expect(git(f.base, "rev-parse", `refs/heads/${f.prefix}tags/local-tag`)).toBe(side);
    expect(git(f.base, "rev-parse", `refs/heads/${f.prefix}tags/local-release`)).toBe(unpushed);
    expect(git(f.base, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(ref => !ref.startsWith(`refs/heads/${f.prefix}`))).toEqual(["refs/heads/main"]);
    expect(git(f.base, "status", "--porcelain")).toBe("");
    for (const target of staging(f.checkout)) expect(await exists(target)).toBe(false);
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "already_worktree_backed" });
    expect(await listNestedCloneMigrationNames(db, await f.row())).toEqual([]);
  });

  it("keeps commits that only the clone's remote-tracking refs still hold", async () => {
    const f = await fixture();
    git(f.nested.author, "checkout", "-q", "-b", "squashed-away");
    await fs.writeFile(path.join(f.nested.author, "feature.txt"), "feature\n");
    git(f.nested.author, "add", "."); git(f.nested.author, "commit", "-qm", "Feature");
    const feature = git(f.nested.author, "rev-parse", "HEAD");
    git(f.nested.author, "push", "-q", f.nested.remote, "squashed-away");
    git(f.checkout, "fetch", "-q", "origin");
    git(f.nested.remote, "branch", "-D", "squashed-away");
    git(f.nested.remote, "reflog", "expire", "--expire=now", "--all");
    git(f.nested.remote, "gc", "-q", "--prune=now");
    expect(() => git(f.base, "cat-file", "-e", `${feature}^{commit}`)).toThrow();
    expect(await f.migrate()).toMatchObject({ outcome: "migrated" });
    expect(git(f.base, "rev-parse", `refs/heads/${f.prefix}remotes/origin/squashed-away`)).toBe(feature);
    expect(git(f.checkout, "cat-file", "-t", feature)).toBe("commit");
  });

  it("expires a converted checkout whose only extra history is remote-tracking and restores that history", async () => {
    const f = await fixture({ issueStatus: "done" });
    git(f.nested.author, "checkout", "-q", "-b", "squashed-away");
    await fs.writeFile(path.join(f.nested.author, "feature.txt"), "feature\n");
    git(f.nested.author, "add", "."); git(f.nested.author, "commit", "-qm", "Feature");
    const feature = git(f.nested.author, "rev-parse", "HEAD");
    git(f.nested.author, "push", "-q", f.nested.remote, "squashed-away");
    git(f.checkout, "fetch", "-q", "origin");
    git(f.nested.remote, "branch", "-D", "squashed-away");
    git(f.nested.remote, "reflog", "expire", "--expire=now", "--all");
    git(f.nested.remote, "gc", "-q", "--prune=now");
    expect(await f.migrate()).toMatchObject({ outcome: "migrated" });

    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
    for (const line of ownedRefs(f.base, f.prefix).split("\n").filter(Boolean)) git(f.base, "update-ref", "-d", line.split(" ")[0]!);
    git(f.base, "reflog", "expire", "--expire=now", "--all");
    git(f.base, "gc", "-q", "--prune=now");
    expect(() => git(f.base, "cat-file", "-e", `${feature}^{commit}`)).toThrow();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.checkout, "cat-file", "-t", feature)).toBe("commit");
  });

  it("fingerprints a converted checkout's own history rather than the shared clone's remote refs", async () => {
    const f = await fixture();
    expect(await f.migrate()).toMatchObject({ outcome: "migrated" });
    const head = git(f.checkout, "rev-parse", "HEAD");
    const before = await restorePointHistoryDigest(f.checkout);
    git(f.base, "update-ref", "refs/remotes/origin/another-task", head);
    expect(await restorePointHistoryDigest(f.checkout)).toBe(before);
    git(f.base, "update-ref", `refs/heads/${f.prefix}remotes/origin/extra`, head);
    expect(await restorePointHistoryDigest(f.checkout)).not.toBe(before);
    for (let index = 0; index < 64; index++) git(f.base, "update-ref", `refs/heads/${f.prefix}remotes/origin/bulk-${index}`, head);
    await expect(restorePointHistoryDigest(f.checkout)).rejects.toThrow("managed_checkout_local_tip_budget");
  });

  it("finishes an interrupted conversion after the workspace is archived and forgets one whose workspace is gone", async () => {
    const f = await fixture();
    const { unpushed } = await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    expect(await f.migrate({ hooks: { afterMove: async () => { throw new Error("simulated crash"); } } })).toMatchObject({ outcome: "skipped" });
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, f.workspaceId));
    const service = executionWorkspaceService(db, { nestedCloneMigrationEnabled: true });
    await service.sweepTerminalWorkspaces();
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
    expect(await exists(`${f.checkout}.clone-standalone`)).toBe(false);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await currentRestorePointSnapshot(f.checkout)).toEqual(before);
    expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();

    const second = await f.task("two");
    await nestedWork(second.checkout);
    expect(await second.migrate({ hooks: { afterAside: async () => { throw new Error("simulated crash"); } } })).toMatchObject({ outcome: "skipped" });
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, second.workspaceId));
    await fs.rm(second.cwd, { recursive: true, force: true });
    expect(await second.migrate()).toMatchObject({ outcome: "rolled_back", reason: "workspace_removed" });
    expect((await second.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
    expect(git(f.base, "rev-parse", `refs/heads/${second.prefix}main`)).toBeTruthy();
  });

  it("skips a nested clone with a stash without changing anything", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.checkout, "nested.txt"), "stashed edit\n");
    git(f.checkout, "stash", "-q");
    const before = await currentRestorePointSnapshot(f.checkout);
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "nested_clone_has_stash" });
    await expectUntouched(f, before);
    expect(git(f.checkout, "stash", "list")).not.toBe("");
  });

  it("skips a nested clone whose local excludes the shared clone would not apply", async () => {
    const f = await fixture();
    await fs.appendFile(path.join(f.checkout, ".git", "info", "exclude"), "\nscratch/\n");
    await fs.mkdir(path.join(f.checkout, "scratch"));
    await fs.writeFile(path.join(f.checkout, "scratch", "notes.txt"), "locally excluded\n");
    const before = await currentRestorePointSnapshot(f.checkout);
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "unsupported_info_exclude" });
    await expectUntouched(f, before);
  });

  it("never checks out through filters planted in the shared clone during the conversion", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.checkout, ".gitattributes"), "*.dat filter=evil\n");
    await fs.writeFile(path.join(f.checkout, "blob.dat"), "payload\n");
    git(f.checkout, "add", ".gitattributes", "blob.dat"); git(f.checkout, "commit", "-qm", "Attributes");
    await fs.writeFile(path.join(f.checkout, "draft.md"), "untracked work\n");
    const marker = path.join(path.dirname(f.nested.remote), "smudge-ran");
    const before = await currentRestorePointSnapshot(f.checkout);
    const result = await f.migrate({ hooks: { beforeWorktreeAdd: async () => {
      git(f.base, "config", "filter.evil.smudge", `sh -c 'touch ${marker}; cat'`);
      git(f.base, "config", "filter.evil.required", "true");
    } } });
    expect(result).toMatchObject({ outcome: "skipped", reason: "unsupported_base_git_config" });
    expect(await exists(marker)).toBe(false);
    git(f.base, "config", "--remove-section", "filter.evil");
    await expectUntouched(f, before);
  });

  it("skips while a run is live", async () => {
    const f = await fixture();
    await nestedWork(f.checkout);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Fixture", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId, issueId: f.issueId, status: "running" });
    const before = await currentRestorePointSnapshot(f.checkout);
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "live_or_unresolved_consumer" });
    await expectUntouched(f, before);
  });

  it("skips a nested clone whose origin differs from the project repository", async () => {
    const f = await fixture();
    await nestedWork(f.checkout);
    git(f.checkout, "remote", "set-url", "origin", f.main.url);
    const before = await currentRestorePointSnapshot(f.checkout);
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "foreign_origin" });
    await expectUntouched(f, before);
  });

  it("skips a checkout that is not a configured project repository", async () => {
    const f = await fixture();
    const stray = path.join(path.dirname(f.checkout), "stray-0123456789ab");
    git(path.dirname(stray), "clone", "-q", f.nested.url, stray);
    const before = await currentRestorePointSnapshot(stray);
    for (let index = 0; index < 20; index += 1) await fs.mkdir(path.join(path.dirname(f.checkout), `agent-${index.toString(16).padStart(12, "0")}`, ".git"), { recursive: true });
    expect(await listNestedCloneMigrationNames(db, await f.row())).toEqual([f.name]);
    expect(await migrateNestedRepositoryClone(db, await f.row(), "stray-0123456789ab", { resolveGitAuth: noAuth }))
      .toMatchObject({ outcome: "skipped", reason: "unknown_managed_checkout" });
    await expectUntouched(f, before, stray, await nestedWorktreeBranchPrefix(stray));
  });

  it("skips when the project has no shared clone", async () => {
    const f = await fixture({ sharedBase: false });
    expect(await f.migrate()).toMatchObject({ outcome: "skipped", reason: "no_shared_base" });
    expect((await fs.lstat(path.join(f.checkout, ".git"))).isDirectory()).toBe(true);
  });

  it("rolls back and keeps the clone when it changes between capture and verification", async () => {
    const f = await fixture();
    await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    const result = await f.migrate({ hooks: { beforeVerify: async ({ from, to }) => {
      expect(await exists(path.join(to, "node_modules", "pkg", "index.js"))).toBe(true);
      await fs.writeFile(path.join(from, "late.txt"), "written by a concurrent run\n");
    } } });
    expect(result).toMatchObject({ outcome: "skipped", reason: "snapshot_mismatch" });
    await fs.rm(path.join(f.checkout, "late.txt"));
    await expectUntouched(f, before);
    expect(await fs.readFile(path.join(f.checkout, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await fs.readFile(path.join(f.checkout, ".env"), "utf8")).toBe("LOCAL_SETTING=1\n");
  });

  it("serializes two tasks converting against the same shared clone and keeps their branches apart", async () => {
    const f = await fixture();
    const second = await f.task("two");
    const one = await nestedWork(f.checkout);
    await fs.writeFile(path.join(second.checkout, "nested.txt"), "second task work\n");
    git(second.checkout, "commit", "-qam", "Second task unpushed");
    const twoHead = git(second.checkout, "rev-parse", "HEAD");
    let active = 0, peak = 0, reached = 0;
    const hooks = { beforeVerify: async () => {
      reached += 1; active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 200));
      active -= 1;
    } };
    let release!: () => void;
    const held = withNestedRepositoryBaseLock(f.base, () => new Promise<void>(resolve => { release = resolve; }));
    const running = Promise.all([f.migrate({ hooks }), second.migrate({ hooks })]);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(reached).toBe(0);
    expect((await fs.lstat(path.join(f.checkout, ".git"))).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(second.checkout, ".git"))).isDirectory()).toBe(true);
    expect(ownedRefs(f.base, f.prefix)).toBe("");
    release();
    await held;
    const [a, b] = await running;
    expect(a).toMatchObject({ outcome: "migrated" });
    expect(b).toMatchObject({ outcome: "migrated" });
    expect(peak).toBe(1);
    expect(f.prefix).not.toBe(second.prefix);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(one.unpushed);
    expect(git(second.checkout, "rev-parse", "HEAD")).toBe(twoHead);
    expect(ownedRefs(f.base, second.prefix)).toBe(`refs/heads/${second.prefix}main ${twoHead}`);
    expect(ownedRefs(f.base, f.prefix).split("\n")).toHaveLength(4);
    expect(worktreePaths(f.base)).toEqual(expect.arrayContaining([f.checkout, second.checkout]));
  });

  it.each(["afterAside", "afterMove", "afterFinalize"] as const)("recovers a conversion interrupted at %s on the next pass", async (step) => {
    const f = await fixture();
    const { unpushed } = await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    const crashed = await f.migrate({ hooks: { [step]: async () => { throw new Error("simulated crash"); } } });
    expect(crashed).toMatchObject({ outcome: "skipped" });
    expect(await exists(`${f.checkout}.clone-standalone`)).toBe(true);
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toMatchObject({ [f.name]: { phase: step === "afterFinalize" ? "cleanup" : "swap" } });
    expect(await listNestedCloneMigrationNames(db, await f.row())).toEqual([f.name]);
    expect(await f.migrate({ dryRun: true })).toMatchObject({ outcome: "dry_run", reason: "interrupted_migration_pending" });
    expect(await exists(`${f.checkout}.clone-standalone`)).toBe(true);

    const recovered = await f.migrate();
    expect(recovered).toMatchObject({ outcome: "recovered", reason: null, branchName: `${f.prefix}main` });
    expect(recovered.reclaimedBytes).toBeGreaterThan(0);
    expect((await fs.lstat(path.join(f.checkout, ".git"))).isFile()).toBe(true);
    expect(await currentRestorePointSnapshot(f.checkout)).toEqual(before);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(unpushed);
    for (const target of staging(f.checkout)) expect(await exists(target)).toBe(false);
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
    expect(worktreePaths(f.base)).toEqual([await fs.realpath(f.base), f.checkout]);
  });

  it("undoes a conversion interrupted before the swap and then completes it", async () => {
    const f = await fixture();
    const { unpushed } = await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    const realBase = await fs.realpath(f.base);
    const staged = `${f.checkout}.clone-migrating`;
    const branch = `${f.prefix}main`;
    git(realBase, "fetch", "-q", f.checkout, `refs/heads/main:refs/heads/${branch}`);
    git(realBase, "worktree", "add", "-q", staged, branch);
    await fs.rename(path.join(f.checkout, "node_modules"), path.join(staged, "node_modules"));
    const pending = { base: realBase, head: unpushed, branch, refs: [{ ref: `refs/heads/${branch}`, commit: unpushed, upstream: "main" }],
      moves: ["node_modules"], phase: "transfer" };
    const current = await f.row();
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, nestedCloneMigrationPending: { [f.name]: pending } } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await f.migrate({ dryRun: true })).toMatchObject({ outcome: "dry_run", reason: "interrupted_migration_pending" });
    expect(await exists(path.join(staged, "node_modules"))).toBe(true);

    const result = await f.migrate();
    expect(result).toMatchObject({ outcome: "migrated", reason: null });
    expect(await currentRestorePointSnapshot(f.checkout)).toEqual(before);
    expect(await fs.readFile(path.join(f.checkout, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    for (const target of staging(f.checkout)) expect(await exists(target)).toBe(false);
    expect(worktreePaths(f.base)).toEqual([realBase, f.checkout]);
    expect((await f.row()).metadata?.nestedCloneMigrationPending).toBeUndefined();
  });

  it("expires and restores a converted checkout and protects its unpushed work", async () => {
    const f = await fixture({ issueStatus: "done" });
    await fs.writeFile(path.join(f.checkout, "nested.txt"), "nested B (unpushed)\n");
    git(f.checkout, "commit", "-qam", "Nested B unpushed");
    const unpushed = git(f.checkout, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.checkout, "draft.md"), "nested untracked work\n");
    expect(await f.migrate()).toMatchObject({ outcome: "migrated" });
    const realBase = await fs.realpath(f.base);

    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true, skipReason: null });
    expect(await exists(f.cwd)).toBe(false);
    const recipe = (await f.row()).metadata?.gitCacheRestoration as Record<string, any>;
    expect(recipe.contents.checkouts[0]).toMatchObject({ name: f.name, commit: unpushed, branchName: `${f.prefix}main`, worktree: { base: realBase } });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(git(f.checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(realBase, ".git"));
    expect(git(f.checkout, "symbolic-ref", "--short", "HEAD")).toBe(`${f.prefix}main`);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await fs.readFile(path.join(f.checkout, "draft.md"), "utf8")).toBe("nested untracked work\n");

    const second = await f.task("two");
    await nestedWork(second.checkout);
    await fs.rm(path.join(second.checkout, "node_modules"), { recursive: true });
    expect(await second.migrate()).toMatchObject({ outcome: "migrated" });
    expect(await second.expire()).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout_branches" });
    expect(await exists(second.checkout)).toBe(true);
  });

  it("is disabled by default, changes nothing in dry run, and runs from the reaper when enabled", async () => {
    const f = await fixture();
    const { unpushed } = await nestedWork(f.checkout);
    const before = await currentRestorePointSnapshot(f.checkout);
    const disabled = executionWorkspaceService(db);
    await disabled.sweepTerminalWorkspaces();
    await expectUntouched(f, before);
    expect(await disabled.nextTerminalWorkspaceSweepAt()).toBeNull();

    const dryRun = executionWorkspaceService(db, { nestedCloneMigrationEnabled: true, nestedCloneMigrationDryRun: true });
    await dryRun.sweepTerminalWorkspaces();
    await expectUntouched(f, before);
    expect(await dryRun.nextTerminalWorkspaceSweepAt()).toBeNull();

    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Fixture", role: "engineer", adapterType: "process" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId: f.issueId, status: "running" }).returning();
    // Make a second clock read observably different without changing the
    // scheduler's saved business deadline during an early inspection.
    let tick = Date.now();
    const busy = executionWorkspaceService(db, { nestedCloneMigrationEnabled: true, now: () => new Date(tick++) });
    await busy.sweepTerminalWorkspaces();
    await expectUntouched(f, before);
    const retryAt = await busy.nextTerminalWorkspaceSweepAt();
    expect(retryAt).toBeGreaterThan(Date.now());
    await busy.sweepTerminalWorkspaces();
    expect(await busy.nextTerminalWorkspaceSweepAt()).toBe(retryAt);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));

    const enabled = executionWorkspaceService(db, { nestedCloneMigrationEnabled: true });
    await enabled.sweepTerminalWorkspaces();
    expect((await fs.lstat(path.join(f.checkout, ".git"))).isFile()).toBe(true);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(unpushed);
    expect(await currentRestorePointSnapshot(f.checkout)).toEqual(before);
    expect(await enabled.nextTerminalWorkspaceSweepAt()).toBeNull();
  });
});
