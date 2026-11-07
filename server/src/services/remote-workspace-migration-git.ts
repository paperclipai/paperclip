import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces, workspaceOperations, type Db } from "@paperclipai/db";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import type { StorageService } from "../storage/types.js";
import { createIssueGitRemoteAuthProvider } from "./git-credentials.js";
import { applyGitRestorePointToWorktree, ensureGitRestorePointCommit, loadGitRestorePoint } from "./git-restore-point-storage.js";
import { copyVerifiedGitExcludes } from "./git-repository-excludes.js";
import { restoreGitWorkspaceContents, type ManagedCheckoutSource } from "./git-workspace-contents.js";
import { ensureSavedGitCommit, gitRestorePointExpired, managedSourcePaths, readGitCacheRestoration,
  verifiedGitCacheSource, verifiedManagedGitObjectSource, type GitCacheRestoration } from "./git-workspace-restoration.js";
import { localRepositoryPath } from "./local-repository-path.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { isRuntimeOwnedGitBranch } from "./execution-workspace-branch-ownership.js";
import { physicalPath } from "./remote-workspace-migration-tree.js";
import { formatCommandForDisplay } from "./workspace-command-display.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { recordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";

type Workspace = typeof executionWorkspaces.$inferSelect;
export type ArchivedGitMigrationSource = {
  commit: string;
  sourcePath: string;
  cleanupOperationId: string | null;
  recipe: GitCacheRestoration | null;
  retainedBranch?: string;
};
const execute = promisify(execFile);
const unavailable = () => new Error("remote_workspace_migration_archived_git_source_unavailable");
function originalLocalSource(workspace: Workspace, sourcePath: string) {
  return Boolean(workspace.repoUrl && /^file:/i.test(workspace.repoUrl) && localRepositoryPath(workspace.repoUrl) === sourcePath
    && !managedSourcePaths(workspace).includes(sourcePath) && recordedIsolatedRemoteSource(workspace) !== sourcePath);
}
function originalDeletionReceipt(workspace: Workspace, operation: typeof workspaceOperations.$inferSelect | undefined) {
  return Boolean(operation && workspace.closedAt && operation.phase === "worktree_cleanup" && operation.status === "succeeded"
    && operation.exitCode === 0 && operation.finishedAt && operation.finishedAt >= operation.startedAt && operation.startedAt >= workspace.closedAt
    && operation.companyId === workspace.companyId && operation.executionWorkspaceId === workspace.id
    && (!operation.issueId || operation.issueId === workspace.sourceIssueId)
    && operation.command === `git branch -d ${workspace.branchName}` && operation.metadata?.cleanupAction === "branch_delete"
    && operation.metadata.workspaceId === workspace.id && operation.metadata.workspacePath === (workspace.providerRef ?? workspace.cwd)
    && operation.metadata.branchName === workspace.branchName);
}
async function localGit(cwd: string, args: string[]) {
  return (await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`,
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
  })).stdout.trim();
}
async function verifiedOriginalLocalSource(workspace: Workspace, sourcePath: string, configuredCwd?: string | null) {
  for (const primary of new Set([recordedIsolatedRemoteSource(workspace), ...managedSourcePaths(workspace), configuredCwd].filter((value): value is string => typeof value === "string"))) {
    const present = await fs.lstat(primary).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (present || await physicalPath(primary) !== primary) throw unavailable();
  }
  const root = resolvePaperclipInstanceRoot(), relative = path.relative(root, sourcePath), full = workspace.metadata?.baseRefSha;
  if (!originalLocalSource(workspace, sourcePath) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative) || path.resolve(sourcePath) !== sourcePath || await fs.realpath(root) !== root
    || typeof full !== "string" || !/^[a-f0-9]{40}$/.test(full)) throw unavailable();
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
  }
  const pending = [sourcePath]; let entries = 0;
  while (pending.length) {
    const directory = await fs.opendir(pending.pop()!);
    for await (const entry of directory) {
      if (++entries > 10_000) throw unavailable();
      const target = path.join(directory.path, entry.name), stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw unavailable();
      if (stat.isDirectory()) pending.push(target);
    }
  }
  for (const name of ["objects", "refs"]) {
    const entry = await fs.lstat(path.join(sourcePath, name));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
  }
  const config = await fs.lstat(path.join(sourcePath, "config"));
  if (!config.isFile() || config.isSymbolicLink() || config.nlink !== 1 || config.size > 64 * 1024) throw unavailable();
  for (const name of ["objects/info/alternates", "objects/info/http-alternates", "refs/replace", "info/grafts", "shallow", "commondir"]) {
    const entry = await fs.lstat(path.join(sourcePath, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (entry) throw unavailable();
  }
  const keys = (await localGit(sourcePath, ["config", "--local", "--no-includes", "--name-only", "--null", "--list"])).split("\0").filter(Boolean);
  if (keys.some(key => !/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch|mirror))$/.test(key))
    || await localGit(sourcePath, ["rev-parse", "--is-bare-repository"]) !== "true"
    || await localGit(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== sourcePath
    || await localGit(sourcePath, ["rev-parse", "--show-object-format"]) !== "sha1"
    || await localGit(sourcePath, ["rev-parse", "--verify", `${full}^{commit}`]) !== full) throw unavailable();
  const refs = (await localGit(sourcePath, ["for-each-ref", "--format=%(objectname) %(refname)"])).split("\n").filter(Boolean);
  if (!refs.length || refs.length > 64 || refs.some(ref => !ref.startsWith(`${full} refs/heads/`) && !ref.startsWith(`${full} refs/tags/`))) throw unavailable();
  return sourcePath;
}
function verifiedReceiptObjectSource(workspace: Workspace, sourcePath: string, configuredCwd?: string | null) {
  if (originalLocalSource(workspace, sourcePath)) return verifiedOriginalLocalSource(workspace, sourcePath, configuredCwd);
  return managedSourcePaths(workspace).includes(sourcePath)
    ? verifiedManagedGitObjectSource(workspace, sourcePath) : verifiedGitCacheSource(workspace, sourcePath);
}
async function git(cwd: string, args: string[]) {
  return (await execute("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  })).stdout.trim();
}

async function assertNoRetainedWorktree(sourcePath: string, expected: string, branch: string) {
  const target = await physicalPath(expected);
  const common = path.join(sourcePath, ".git");
  const admin = path.join(common, "worktrees");
  const entries = await fs.readdir(admin, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw unavailable();
    if (!entry.isDirectory()) continue;
    const root = path.join(admin, entry.name);
    const pointer = await fs.readFile(path.join(root, "gitdir"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (pointer && await physicalPath(pointer.trim()) === path.join(target, ".git")) throw unavailable();
    // An index without its registration can still own staged work. It has no
    // reliable checkout identity, so a branch-only import cannot discard it.
    if (!pointer && await fs.lstat(path.join(root, "index")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })) throw unavailable();
  }
  const records = (await git(sourcePath, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
  for (const record of records) {
    const fields = record.split("\0");
    const worktree = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (fields.includes(`branch refs/heads/${branch}`) || worktree && await physicalPath(worktree) === target) throw unavailable();
  }
}

/** A removed branch must be reconstructed from its saved commit or its exact
 * successful deletion receipt. Today's default branch is never a substitute. */
export async function inspectArchivedGitMigrationSource(db: Pick<Db, "select">, workspace: Workspace,
  options: { allowActiveRetainedBranch?: boolean; operationId?: string } = {}): Promise<ArchivedGitMigrationSource | null> {
  const archived = workspace.status === "archived";
  if ((!archived && !options.allowActiveRetainedBranch) || !workspace.repoUrl || !workspace.branchName || !workspace.sourceIssueId) return null;
  const recipe = readGitCacheRestoration(workspace);
  if (recipe) {
    if (!archived) return null;
    if (gitRestorePointExpired(recipe)) throw new Error("remote_workspace_migration_restore_point_expired");
    return { commit: recipe.commit, sourcePath: recipe.sourcePath, recipe, cleanupOperationId: null };
  }
  if (workspace.providerType !== "git_worktree" || workspace.metadata?.gitBranchOwnershipVersion !== 1) return null;
  const [projectWorkspace] = workspace.projectWorkspaceId ? await db.select({ cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces).where(and(eq(projectWorkspaces.id, workspace.projectWorkspaceId),
      eq(projectWorkspaces.companyId, workspace.companyId), workspace.projectId ? eq(projectWorkspaces.projectId, workspace.projectId) : undefined)) : [];
  const privateSource = recordedIsolatedRemoteSource(workspace);
  const privatePresent = privateSource ? await fs.lstat(privateSource).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) : null;
  const [journal] = options.operationId ? await db.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.id, options.operationId), eq(workspaceOperations.phase, "remote_workspace_migration"),
  )) : [];
  const saved = journal?.metadata?.archivedGitSource;
  const savedPath = saved && typeof saved === "object" && !Array.isArray(saved)
    && typeof (saved as { sourcePath?: unknown }).sourcePath === "string" ? (saved as { sourcePath: string }).sourcePath : null;
  let sourcePath = savedPath ?? (privatePresent && privateSource ? privateSource : projectWorkspace?.cwd ?? managedSourcePaths(workspace)[0]);
  if (!sourcePath || !privatePresent && projectWorkspace?.repoUrl && projectWorkspace.repoUrl !== workspace.repoUrl) throw unavailable();
  const [operation] = archived && workspace.closedAt ? await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.phase, "worktree_cleanup"), eq(workspaceOperations.status, "succeeded"),
    or(eq(workspaceOperations.command, `git branch -d ${workspace.branchName}`), and(
      sql`${workspaceOperations.metadata}->>'cleanupAction' = 'branch_delete'`,
      sql`${workspaceOperations.metadata}->>'workspaceId' = ${workspace.id}`,
      sql`${workspaceOperations.metadata}->>'branchName' = ${workspace.branchName}`,
      sql`${workspaceOperations.metadata}->>'workspacePath' = ${workspace.providerRef ?? workspace.cwd}`,
    )), gte(workspaceOperations.startedAt, workspace.closedAt),
  )).orderBy(desc(workspaceOperations.startedAt), desc(workspaceOperations.id)).limit(1) : [];
  if (!operation) {
    // A branch that was never deleted still owns its committed tree. It does
    // not certify lost untracked files. Any surviving worktree registration
    // can retain additional index/files authority and must stay blocked.
    if (workspace.mode !== "isolated_workspace" || !workspace.projectId || !managedSourcePaths(workspace).includes(sourcePath)) return null;
    await assertNoRetainedWorktree(sourcePath, path.join(sourcePath, ".paperclip", "worktrees", workspace.branchName), workspace.branchName);
    await git(sourcePath, ["check-ref-format", `refs/heads/${workspace.branchName}`]);
    const expected = path.join(sourcePath, ".paperclip", "worktrees", workspace.branchName);
    if (workspace.cwd !== expected || workspace.providerRef && workspace.providerRef !== expected) return null;
    let removalId: string | null = null;
    if (!isRuntimeOwnedGitBranch(workspace.metadata)) {
      // User-owned branches must not be deleted. A successful unforced removal
      // proves their old checkout was clean; preserve the branch without
      // converting that receipt into branch-deletion authority.
      if (workspace.metadata?.createdByRuntime !== false || !archived || !workspace.closedAt) return null;
      const [removal] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
        eq(workspaceOperations.phase, "worktree_cleanup"), eq(workspaceOperations.status, "succeeded"),
        eq(workspaceOperations.command, formatCommandForDisplay("git", ["worktree", "remove", expected])), isNotNull(workspaceOperations.finishedAt),
        gte(workspaceOperations.startedAt, workspace.closedAt),
        sql`${workspaceOperations.metadata}->>'cleanupAction' = 'worktree_remove'`,
        sql`${workspaceOperations.metadata}->>'workspaceId' = ${workspace.id}`,
        sql`${workspaceOperations.metadata}->>'workspacePath' = ${expected}`,
        sql`${workspaceOperations.metadata}->>'branchName' = ${workspace.branchName}`,
      )).orderBy(desc(workspaceOperations.startedAt), desc(workspaceOperations.id)).limit(1);
      if (!removal) return null;
      removalId = removal.id;
    }
    await verifiedManagedGitObjectSource(workspace, sourcePath);
    const [other] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, workspace.companyId), eq(executionWorkspaces.projectId, workspace.projectId),
      eq(executionWorkspaces.repoUrl, workspace.repoUrl), eq(executionWorkspaces.branchName, workspace.branchName),
      ne(executionWorkspaces.id, workspace.id),
    )).limit(1);
    if (other) throw unavailable();
    const commit = await git(sourcePath, ["rev-parse", "--verify", `refs/heads/${workspace.branchName}^{commit}`]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw unavailable();
    return { commit, sourcePath, cleanupOperationId: removalId, recipe: null, retainedBranch: workspace.branchName };
  }
  const receipt = operation?.stdoutExcerpt?.trim(), prefix = `Deleted branch ${workspace.branchName} (was `;
  if (!operation || !receipt?.startsWith(prefix) || !receipt.endsWith(").")) return null;
  const abbreviation = receipt.slice(prefix.length, -2);
  if (!/^[a-f0-9]{7,40}$/.test(abbreviation)) throw unavailable();
  if (!savedPath && managedSourcePaths(workspace).includes(sourcePath)) {
    const present = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!present) {
      const original = workspace.repoUrl && /^file:/i.test(workspace.repoUrl) ? localRepositoryPath(workspace.repoUrl) : null;
      if (original && projectWorkspace?.repoUrl === workspace.repoUrl && originalDeletionReceipt(workspace, operation)
        && await physicalPath(sourcePath) === sourcePath) sourcePath = original;
    }
  }
  if (originalLocalSource(workspace, sourcePath) && (!projectWorkspace || projectWorkspace.repoUrl !== workspace.repoUrl
    || !originalDeletionReceipt(workspace, operation))) throw unavailable();
  await verifiedReceiptObjectSource(workspace, sourcePath, projectWorkspace?.cwd);
  const commit = await (originalLocalSource(workspace, sourcePath) ? localGit : git)(sourcePath, ["rev-parse", "--verify", `${abbreviation}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(commit) || originalLocalSource(workspace, sourcePath) && commit !== workspace.metadata?.baseRefSha) throw unavailable();
  return { commit, sourcePath, cleanupOperationId: operation.id, recipe: null };
}

/** Restore only into private migration scratch. Original repositories, task
 * folders, lifecycle state and restore-point metadata remain unchanged. */
async function authorizeNestedSource(db: Pick<Db, "select">, workspace: Workspace, saved: ManagedCheckoutSource, lock = false) {
  if (!workspace.projectId) throw unavailable();
  const query = db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
    eq(projectWorkspaces.id, saved.id), eq(projectWorkspaces.companyId, workspace.companyId),
    eq(projectWorkspaces.projectId, workspace.projectId),
  ));
  const [row] = await (lock ? query.for("share", { noWait: true }) : query);
  if (!row || row.repoUrl !== saved.repoUrl) throw unavailable();
}

export async function lockArchivedGitMigrationSources(db: Pick<Db, "select">, workspace: Workspace, source: ArchivedGitMigrationSource) {
  if (originalLocalSource(workspace, source.sourcePath)) {
    const [configured] = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.id, workspace.projectWorkspaceId!),
      eq(projectWorkspaces.projectId, workspace.projectId!))).for("share", { noWait: true });
    const [receipt] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, workspace.companyId),
      eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.id, source.cleanupOperationId!))).for("share", { noWait: true });
    if (!configured || configured.repoUrl !== workspace.repoUrl || !receipt || !originalDeletionReceipt(workspace, receipt)
      || source.commit !== workspace.metadata?.baseRefSha) throw unavailable();
    const prefix = `Deleted branch ${workspace.branchName} (was `, output = receipt.stdoutExcerpt?.trim();
    if (!output?.startsWith(prefix) || !output.endsWith(").") || !/^[a-f0-9]{7,40}$/.test(output.slice(prefix.length, -2))
      || !source.commit.startsWith(output.slice(prefix.length, -2))) throw unavailable();
  }
  for (const checkout of [...(source.recipe?.contents?.checkouts ?? [])].sort((a, b) => a.source.id.localeCompare(b.source.id))) {
    await authorizeNestedSource(db, workspace, checkout.source, true);
  }
}


export async function materializeArchivedGitMigrationSource(input: {
  db: Db; storage: StorageService; workspace: Workspace; source: ArchivedGitMigrationSource; scratch: string;
}) {
  const { workspace, source } = input, cwd = path.join(input.scratch, "retained-git");
  if (!workspace.sourceIssueId || !workspace.repoUrl || !workspace.branchName) throw unavailable();
  const original = originalLocalSource(workspace, source.sourcePath), runGit = original ? localGit : git;
  if (original && (source.recipe || !source.cleanupOperationId || source.retainedBranch || source.commit !== workspace.metadata?.baseRefSha)) throw unavailable();
  const resolveGitAuth = original ? async () => { throw unavailable(); } : createIssueGitRemoteAuthProvider(input.db, workspace.companyId, workspace.sourceIssueId);
  const present = await fs.lstat(source.sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (present) {
    // A deletion receipt owns a specific committed tree. Its objects can come
    // from the verified project cache after the private checkout was removed.
    // Saved private edits still require their original restore-point source.
    if (!source.recipe && !source.cleanupOperationId && source.retainedBranch !== workspace.branchName) throw unavailable();
    const verified = source.recipe ? await verifiedGitCacheSource(workspace, source.sourcePath)
      : await verifiedReceiptObjectSource(workspace, source.sourcePath);
    if (source.retainedBranch && (await runGit(verified, ["rev-parse", "--verify", `refs/heads/${source.retainedBranch}^{commit}`])) !== source.commit) throw unavailable();
    await fs.mkdir(cwd, { mode: 0o700 }); await runGit(cwd, ["init", "--quiet"]);
    if (source.recipe?.restorePoint) await copyVerifiedGitExcludes(verified, cwd).catch(() => { throw unavailable(); });
    // Fetch objects, never the current working tree of a shared project root.
    const presentCommit = await runGit(verified, ["cat-file", "-e", `${source.commit}^{commit}`]).then(() => true, () => false);
    if (presentCommit) {
      await runGit(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "--", verified, source.commit]);
    } else if (source.recipe?.restorePoint && !source.recipe.restorePoint.headOnRemote) {
      // The archived branch can have been pruned from the base while its
      // encrypted bundle still owns the unpushed commits. Import only that
      // bundle's explicit prerequisites, then let the restore-point owner
      // verify and import the saved history below.
      const { manifest } = await loadGitRestorePoint({ storage: input.storage, workspace, ref: source.recipe.restorePoint });
      for (const commit of manifest.prerequisites) {
        const local = await runGit(verified, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false);
        if (local) await runGit(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "--", verified, commit]);
        else await ensureSavedGitCommit(cwd, workspace.repoUrl, commit, resolveGitAuth);
      }
    }
  } else {
    if (!source.recipe) throw unavailable();
    await materializeManagedProjectWorkspace(cwd, { repoUrl: workspace.repoUrl, resolveGitAuth });
  }
  if (source.recipe?.restorePoint) await ensureGitRestorePointCommit({ storage: input.storage, workspace,
    ref: source.recipe.restorePoint, repositoryCwd: cwd });
  if (original) await runGit(cwd, ["cat-file", "-e", `${source.commit}^{commit}`]);
  else await ensureSavedGitCommit(cwd, workspace.repoUrl, source.commit, resolveGitAuth);
  await runGit(cwd, ["check-ref-format", `refs/heads/${workspace.branchName}`]);
  await runGit(cwd, ["checkout", "--detach", source.commit]);
  await runGit(cwd, ["update-ref", `refs/heads/${workspace.branchName}`, source.commit]);
  await runGit(cwd, ["symbolic-ref", "HEAD", `refs/heads/${workspace.branchName}`]);
  await runGit(cwd, ["config", "remote.origin.url", workspace.repoUrl]);
  if (source.recipe?.restorePoint) await applyGitRestorePointToWorktree({ storage: input.storage, workspace,
    ref: source.recipe.restorePoint, repositoryCwd: cwd, worktreePath: cwd, preserveImportedHistory: true });
  const approvedLocalSources = new Set<string>();
  await restoreGitWorkspaceContents({ cwd, companyId: workspace.companyId, workspaceId: workspace.id,
    projectId: workspace.projectId, contents: source.recipe?.contents, storage: input.storage, resolveGitAuth, isolateRepositories: true,
    authorizeSource: async saved => {
      await authorizeNestedSource(input.db, workspace, saved);
      const local = localRepositoryPath(saved.repoUrl); if (local) approvedLocalSources.add(local);
    },
    prepareLocalSource: async local => {
      if (!approvedLocalSources.has(local)) throw unavailable();
      const identity = await fs.realpath(local);
      return async () => { if (await fs.realpath(local) !== identity) throw unavailable(); };
    },
  });
  // A checkout records scratch-file inode and time fields in its index. Those
  // fields must not change the saved archive identity after an upload reply is
  // lost. Rebuild only these reconstructed indexes from their staged trees;
  // the original repository and unstaged files remain untouched.
  for (const repository of [cwd, ...(source.recipe?.contents?.checkouts ?? [])
    .map(checkout => path.join(cwd, PROJECT_REPOSITORIES_DIR, checkout.name))]) {
    const tree = await runGit(repository, ["write-tree"]);
    await runGit(repository, ["read-tree", "--empty"]);
    await runGit(repository, ["read-tree", tree]);
  }
  return cwd;
}
