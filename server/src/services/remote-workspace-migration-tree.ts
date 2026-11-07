import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { assertCurrentWorkspaceSourceHeld, managedProjectSourceIdentity, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { readWorkspaceGitSourceRoots } from "./workspace-git-source-roots.js";
import { localWorkspaceSourcePaths } from "./execution-workspace-source-roots.js";
import { offlineMigrationExecutionWhere } from "./offline-migration-execution.js";
import type { StorageService } from "../storage/types.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive, type WorkspaceSnapshotRef } from "./remote-workspace-snapshot-storage.js";

type ReadDb = Pick<Db, "select">;
type Workspace = typeof executionWorkspaces.$inferSelect;
type SourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type NestedVerificationInput = {
  db: Db; storage: StorageService; workspace: Workspace; scratch: string; signal?: AbortSignal;
  recordedChildren?: ImportedWorkspaceChild[]; gitSourceRoots?: string[];
};
type NestedVerification = {
  abort(error: unknown): void;
  immutable(reference: WorkspaceSnapshotRef, children: ImportedWorkspaceChild[], operationId: string,
    archivePath: string, restored: string): Promise<void>;
};
export type ImportedWorkspaceChild = {
  workspaceId: string; snapshotId: string; operationId: string; relativePath: string; manifestDigest: string;
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const rootOf = (workspace: Pick<Workspace, "cwd" | "providerRef">) => workspace.cwd ?? workspace.providerRef;

// Missing historical paths still resolve through their nearest surviving
// parent, so a symlinked ancestor cannot hide an alias from the writer fence.
export async function physicalPath(value: string): Promise<string> {
  let current = path.resolve(value); const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === path.dirname(current)) throw error;
      missing.push(path.basename(current)); current = path.dirname(current);
    }
  }
}

export function validateImportedWorkspaceChildren(raw: unknown): ImportedWorkspaceChild[] {
  if (!Array.isArray(raw) || raw.some(child => !child || typeof child !== "object"
    || typeof child.relativePath !== "string" || !child.relativePath.startsWith(".paperclip/worktrees/")
    || child.relativePath.split("/").some((part: string) => !part || part === "." || part === "..")
    || !/^[a-f0-9-]{36}$/.test(child.workspaceId) || !/^[a-f0-9-]{36}$/.test(child.snapshotId)
    || !/^[a-f0-9-]{36}$/.test(child.operationId) || !/^[a-f0-9]{64}$/.test(child.manifestDigest)))
    throw new Error("nested_workspace_coverage_invalid");
  return raw;
}

export async function offlineWorkspaceMigrationBlockers(db: ReadDb) {
  if (process.env.PAPERCLIP_EPHEMERAL_MIGRATION !== "true") return ["offline_maintenance_required"];
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(offlineMigrationExecutionWhere()).limit(1);
  return active ? ["active_execution_requires_drain"] : [];
}

export type WorkspaceSourceScope = {
  root: string; projectId: string | null; issueIds: string[]; workspaceIds: string[]; device: number; inode: number;
  physicalRoots?: string[]; gitSourceRoots?: string[]; settledPreparedWorkspaceIds?: string[]; settledRecoveryIssueIds?: string[]; settledFinalizationRunIds?: string[];
  importedChildren?: Array<{ operationId: string; sourcePath: string }>;
};

export async function requiresOnlineOrdinarySource(workspace: Workspace): Promise<boolean> {
  if (workspace.providerType !== "local_fs" || workspace.repoUrl || workspace.branchName) return false;
  const instance = await physicalPath(resolvePaperclipInstanceRoot());
  for (const cwd of localWorkspaceSourcePaths(workspace)) {
    const root = await physicalPath(cwd);
    const parts = path.relative(instance, root).split(path.sep);
    const managed = parts[1] === workspace.companyId && Boolean(workspace.sourceIssueId) && (
      parts[0] === "projects" && parts.length === 4 && /^[a-f0-9-]{36}$/.test(parts[2])
      || parts[2] === workspace.sourceIssueId && (parts[0] === "isolated-workspaces" && parts.length === 3
        || parts[0] === "isolated-workspace-attempts" && parts.length === 4));
    if (!managed) continue;
    const entry = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (entry?.isDirectory() && !entry.isSymbolicLink()) return true;
  }
  return false;
}

export async function inspectOnlineOrdinarySource(db: ReadDb, workspace: Workspace): Promise<Omit<WorkspaceSourceScope, "importedChildren"> | null> {
  if (!workspace.cwd || workspace.providerType !== "local_fs" || workspace.repoUrl || workspace.branchName) return null;
  const root = await physicalPath(workspace.cwd);
  const instance = await physicalPath(resolvePaperclipInstanceRoot());
  const parts = path.relative(instance, root).split(path.sep);
  const isolated = workspace.sourceIssueId && workspace.mode === "isolated_workspace"
    && parts[1] === workspace.companyId && parts[2] === workspace.sourceIssueId
    && (parts[0] === "isolated-workspaces" && parts.length === 3
      || parts[0] === "isolated-workspace-attempts" && parts.length === 4 && /^[a-zA-Z0-9_-]+$/.test(parts[3]));
  const projectId = await managedProjectSourceIdentity(workspace.companyId, root);
  if (root !== workspace.cwd || !(isolated || projectId && path.dirname(root) === path.join(
    instance, "projects", workspace.companyId, projectId))) return null;
  const entry = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return null;
  const columns = { id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
    cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef, providerType: executionWorkspaces.providerType,
    repoUrl: executionWorkspaces.repoUrl, branchName: executionWorkspaces.branchName, sourceIssueId: executionWorkspaces.sourceIssueId,
    strategyType: executionWorkspaces.strategyType, mode: executionWorkspaces.mode, status: executionWorkspaces.status,
    metadata: sql<Record<string, unknown>>`jsonb_build_object(
      'gitCacheRestoration', ${executionWorkspaces.metadata}->'gitCacheRestoration',
      'nestedCloneMigrationPending', ${executionWorkspaces.metadata}->'nestedCloneMigrationPending',
      'remoteWorkspace', ${executionWorkspaces.metadata}->'remoteWorkspace')`,
  };
  const rows = await db.select(columns).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, workspace.companyId),
    inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]))).limit(1001);
  if (rows.length > 1000) return null;
  const aliases: typeof rows = [];
  for (const row of rows) {
    const paths = localWorkspaceSourcePaths(row);
    let physical: string[];
    try { physical = await Promise.all(paths.map(physicalPath)); } catch { return null; }
    if (!physical.some(cwd => overlaps(root, cwd))) continue;
    if (row.cwd !== root || row.providerRef && row.providerRef !== root
      || row.providerType !== "local_fs" || row.repoUrl || row.branchName || !row.sourceIssueId
      || isolated && row.sourceIssueId !== workspace.sourceIssueId
      || row.strategyType !== "project_primary" || !["isolated_workspace", "shared_workspace"].includes(row.mode)
      || !["active", "idle", "in_review", "archived"].includes(row.status) || row.metadata?.remoteWorkspace
      || row.metadata?.gitCacheRestoration || row.metadata?.nestedCloneMigrationPending) return null;
    aliases.push(row);
  }
  let after: string | undefined;
  for (let page = 0; ; page++) {
    const foreign = await db.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(and(
      ne(executionWorkspaces.companyId, workspace.companyId),
      inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]),
      ...(after ? [gt(executionWorkspaces.id, after)] : []),
    )).orderBy(executionWorkspaces.id).limit(256);
    for (const row of foreign) {
      for (const cwd of localWorkspaceSourcePaths(row)) {
        try { if (overlaps(root, await physicalPath(cwd))) return null; } catch { return null; }
      }
    }
    if (foreign.length < 256) break;
    if (page === 39) return null;
    after = foreign.at(-1)!.id;
  }
  if (!aliases.some(row => row.id === workspace.id) || aliases.length > 64) return null;
  return { root, projectId, device: entry.dev, inode: entry.ino,
    issueIds: [...new Set(aliases.map(row => row.sourceIssueId!))].sort(), workspaceIds: aliases.map(row => row.id).sort() };
}

export async function onlineOrdinarySourceBlockers(db: Pick<Db, "execute">, companyId: string,
  source: WorkspaceSourceScope, workspace: Pick<Workspace, "id" | "sourceIssueId">, operationId?: string): Promise<string[]> {
  const workspaceIds = sql.join(source.workspaceIds.map(id => sql`${id}::uuid`), sql`, `);
  const issueIds = sql.join(source.issueIds.map(id => sql`${id}::uuid`), sql`, `);
  const settledWorkspaces = sql.join((source.settledPreparedWorkspaceIds?.length ? source.settledPreparedWorkspaceIds : ["00000000-0000-0000-0000-000000000000"]).map(id => sql`${id}`), sql`, `);
  const settledFinalizers = sql.join((source.settledFinalizationRunIds?.length ? source.settledFinalizationRunIds : ["00000000-0000-0000-0000-000000000000"]).map(id => sql`${id}::uuid`), sql`, `);
  const settledRecoveries = sql.join((source.settledRecoveryIssueIds?.length ? source.settledRecoveryIssueIds : ["00000000-0000-0000-0000-000000000000"]).map(id => sql`${id}::uuid`), sql`, `);
  const rows = await db.execute<{ reason: string }>(sql`
    select 'active_execution' reason where exists (select 1 from heartbeat_runs r where r.company_id=${companyId}::uuid
      and r.status in ('queued','running') and (r.issue_id in (${issueIds}) or r.native_issue_id in (${issueIds})
        or r.context_snapshot->>'executionWorkspaceId' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)})
        or r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)})))
    union all select 'task_writer_bound' where exists (select 1 from issues i where i.company_id=${companyId}::uuid
      and i.id in (${issueIds}) and (i.execution_run_id is not null or i.checkout_run_id is not null))
    union all select 'workspace_operation_unresolved' where exists (select 1 from workspace_operations o where o.company_id=${companyId}::uuid
      and o.execution_workspace_id in (${workspaceIds}) and (${operationId ?? null}::uuid is null or o.id<>${operationId ?? null}::uuid)
      and (o.status in ('running','pending') or o.metadata->>'uncertain'='true'))
    union all select 'workspace_runtime_owned' where exists (select 1 from execution_workspace_runtime_leases l where l.company_id=${companyId}::uuid
      and l.execution_workspace_id in (${workspaceIds}) and l.expires_at>clock_timestamp())
    union all select 'workspace_runtime_service_unsettled' where exists (select 1 from workspace_runtime_services s where s.company_id=${companyId}::uuid
      and s.status<>'stopped' and (s.execution_workspace_id in (${workspaceIds}) or s.project_workspace_id in
        (select w.project_workspace_id from execution_workspaces w where w.company_id=${companyId}::uuid and w.id in (${workspaceIds}))))
    union all select 'remote_copyback_unresolved' where exists (select 1 from heartbeat_runs r where r.company_id=${companyId}::uuid
      and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)})
      and (r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}'<>${workspace.id}
        and r.runner_profile_json#>>'{nativeWorkspaceSync,state}'='prepared'
        and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' not in (${settledWorkspaces})
        or r.runner_profile_json->'nativeWorkspaceFinalizationOwner' is not null
        or r.controller_lease_expires_at>clock_timestamp()))
    union all select 'execution_finalization_unresolved' where exists (select 1 from native_run_finalizations f where f.company_id=${companyId}::uuid
      and (f.issue_id in (${issueIds}) and f.issue_id<>${workspace.sourceIssueId}::uuid or f.run_id in
        (select r.id from heartbeat_runs r where r.company_id=${companyId}::uuid
          and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)})
          and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}'<>${workspace.id})) and f.run_id not in (${settledFinalizers}) and (f.phase not in ('committed','terminal_failure') or f.lease_owner is not null))
    union all select 'workspace_recovery_unresolved' where exists (select 1 from issue_recovery_actions a where a.company_id=${companyId}::uuid
      and (a.source_issue_id in (${issueIds}) and a.source_issue_id<>${workspace.sourceIssueId}::uuid or a.source_issue_id in
        (select r.native_issue_id from heartbeat_runs r where r.company_id=${companyId}::uuid
          and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)})
          and r.runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}'<>${workspace.id})) and a.source_issue_id not in (${settledRecoveries}) and a.status in ('active','escalated'))
    union all select 'repository_preparation_unresolved' where exists (select 1 from execution_workspace_repositories r where r.company_id=${companyId}::uuid
      and r.execution_workspace_id in (${workspaceIds}) and r.state<>'ready')`);
  const services = await db.execute<{ cwd: string | null; provider: string }>(sql`
    select cwd, provider from workspace_runtime_services where company_id=${companyId}::uuid and status<>'stopped' limit 1001`);
  const reasons = rows.map(row => row.reason);
  if (services.length > 1000) reasons.push("workspace_runtime_service_unsettled");
  else for (const service of services) {
    try {
      const cwd = service.cwd ? await physicalPath(service.cwd) : null;
      let overlap = cwd ? (source.physicalRoots ?? [source.root]).some(root => overlaps(root, cwd)) : service.provider !== "adapter_managed";
      if (!overlap && cwd && source.gitSourceRoots) {
        const owned = (target: string) => source.gitSourceRoots!.some(root => target === root || target.startsWith(root + path.sep));
        overlap = owned(cwd);
        if (!overlap) {
          const git = await readWorkspaceGitSourceRoots(cwd, { ancestors: true });
          overlap = Boolean(git && [git.gitDirectory.path, git.commonDirectory.path, ...git.objectDirectories.map(root => root.path)].some(owned));
        }
      }
      if (overlap) { reasons.push("workspace_runtime_service_unsettled"); break; }
    } catch { reasons.push("workspace_runtime_service_unsettled"); break; }
  }
  const controlled = [...adapterExecutionControls.keys()];
  if (controlled.length) {
    const active = await db.execute(sql`select id from heartbeat_runs where company_id=${companyId}::uuid
      and id in (${sql.join(controlled.map(id => sql`${id}::uuid`), sql`, `)})
      and runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' in (${sql.join(source.workspaceIds.map(id => sql`${id}`), sql`, `)}) limit 1`);
    if (active.length) return [...reasons, "active_execution"];
  }
  return reasons;
}

/** Only the maintenance entry point can acknowledge that every old deployment
 * has stopped. A task-level migration hold cannot fence other path aliases. */
export async function workspaceMigrationLayoutBlockers(db: ReadDb, workspace: Workspace, writersStopped = false, onlineSource?: WorkspaceSourceScope) {
  if (writersStopped) return offlineWorkspaceMigrationBlockers(db);
  const cwd = rootOf(workspace);
  if (!cwd) return [];
  const local = await db.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd,
    providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, workspace.companyId), ne(executionWorkspaces.id, workspace.id),
    inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]),
  ));
  const root = await physicalPath(cwd);
  for (const row of local) {
    for (const cwd of localWorkspaceSourcePaths(row)) {
      const physical = await physicalPath(cwd);
      if (onlineSource?.gitSourceRoots && physical.startsWith(`${root}/.paperclip/worktrees/`)) {
        const entry = await fs.lstat(physical).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
        if (entry) return ["nested_workspace_import_required"];
      }
      if (!onlineSource?.workspaceIds.includes(row.id) && overlaps(root, physical)) return ["overlapping_workspace_requires_maintenance"];
    }
  }
  const migrated = await db.select({ id: workspaceOperations.id, cwd: workspaceOperations.cwd }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.phase, "remote_workspace_migration"),
    eq(workspaceOperations.status, "succeeded"), ne(workspaceOperations.executionWorkspaceId, workspace.id),
  ));
  for (const row of migrated) {
    if (!row.cwd) continue;
    const sourcePath = await physicalPath(row.cwd);
    if (sourcePath.startsWith(`${root}/.paperclip/worktrees/`)
      && !(onlineSource?.gitSourceRoots && onlineSource.importedChildren?.some(child => child.operationId === row.id && child.sourcePath === sourcePath)))
      return ["overlapping_workspace_requires_maintenance"];
  }
  return [];
}

async function importedWorkspaceCandidates(db: ReadDb, workspace: Workspace) {
  const sourceRoot = rootOf(workspace);
  if (!sourceRoot) return [];
  const root = await physicalPath(sourceRoot);
  const rows = await db.select({ operation: workspaceOperations, snapshot: executionWorkspaceSnapshots })
    .from(workspaceOperations).innerJoin(executionWorkspaceSnapshots, and(
      eq(executionWorkspaceSnapshots.companyId, workspaceOperations.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, workspaceOperations.executionWorkspaceId),
      eq(executionWorkspaceSnapshots.sourceOperationId, workspaceOperations.id),
    )).where(and(eq(workspaceOperations.companyId, workspace.companyId),
      ne(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.phase, "remote_workspace_migration"),
      eq(workspaceOperations.status, "succeeded"), inArray(executionWorkspaceSnapshots.status, ["committed", "superseded"]),
      sql`${workspaceOperations.metadata}->>'snapshotId' = ${executionWorkspaceSnapshots.id}::text`,
    )).orderBy(asc(workspaceOperations.id)).limit(10241);
  if (rows.length > 10240) throw new Error("nested_workspace_scope_limit");
  const located = [];
  for (const row of rows) {
    if (!row.operation.cwd) continue;
    located.push({ ...row, sourcePath: await physicalPath(row.operation.cwd) });
  }
  return located.filter(row => row.sourcePath.startsWith(`${root}/.paperclip/worktrees/`))
    .sort((a, b) => a.sourcePath.length - b.sourcePath.length || a.operation.id.localeCompare(b.operation.id));
}

export async function inspectImportedWorkspaceSourcePaths(db: ReadDb, workspace: Workspace) {
  return (await importedWorkspaceCandidates(db, workspace)).map(({ operation, snapshot, sourcePath }) => ({
    workspaceId: snapshot.executionWorkspaceId, operationId: operation.id, snapshotId: snapshot.id,
    sourcePath, manifestDigest: snapshot.manifestDigest, operationManifestDigest: operation.metadata?.manifestDigest,
  }));
}

/** Runtime-created nested task folders can be omitted only after an exact
 * committed import covers their current bytes. Ordinary user folders stay in
 * the parent archive. The snapshot owner retains the resulting dependencies. */
export function createNestedWorkspaceImportVerifier(input: {
  db: Db; storage: StorageService; companyId: string; sourceLock: SourceTransaction;
  projectIds: readonly string[]; issueIds: readonly string[]; signal?: AbortSignal;
}) {
  const stop = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  const proofs = new Map<string, { etag: string; checked: Promise<boolean> }>();
  let closed = false, current: Promise<ImportedWorkspaceChild[]> | undefined;
  const objectHead = async (reference: WorkspaceSnapshotRef) => {
    try { return await input.storage.headObject(reference.companyId, reference.objectKey, { signal }); }
    catch { signal.throwIfAborted(); return null; }
  };
  const assertOwner = async () => {
    if (closed) throw new Error("nested_workspace_verifier_closed");
    signal.throwIfAborted();
    await withWorkspaceSourceLocks(input.db, { companyId: input.companyId, projectIds: input.projectIds, issueIds: input.issueIds }, async lock => {
      if (lock !== input.sourceLock) throw new Error("nested_workspace_source_fence_changed");
      await lock.execute(sql`select 1`);
    }, true);
  };
  const verification: NestedVerification = {
    abort: error => stop.abort(error),
    immutable: async (reference, children, operationId, archivePath, restored) => {
      const head = await objectHead(reference);
      const etag = head?.exists && head.contentLength === reference.byteSize && typeof head.etag === "string"
        && head.etag.replace(/^"|"$/g, "").trim() && !/^W\//i.test(head.etag) ? head.etag : null;
      const key = createHash("sha256").update(JSON.stringify([reference, children, operationId])).digest("hex");
      const previous = proofs.get(key);
      if (previous && etag === previous.etag
        && await previous.checked) return;
      proofs.delete(key);
      const checked = (async () => {
        await loadWorkspaceSnapshotArchive({ storage: input.storage, reference, targetPath: archivePath, signal });
        await restoreRemoteWorkspaceArchive({ archivePath, targetDir: restored, expectedManifestDigest: reference.manifestDigest, signal });
        if (!etag) return false;
        const after = await objectHead(reference);
        return after !== null && after.exists && after.etag === etag && after.contentLength === reference.byteSize;
      })();
      const proof = etag ? { etag, checked } : null;
      if (proof) proofs.set(key, proof);
      try { if (!await checked && proofs.get(key) === proof) proofs.delete(key); }
      catch (error) { if (proofs.get(key) === proof) proofs.delete(key); throw error; }
    },
  };
  return {
    prepare(options: Omit<NestedVerificationInput, "db" | "storage" | "signal">): Promise<ImportedWorkspaceChild[]> {
      if (closed || current) return Promise.reject(new Error("nested_workspace_verifier_unavailable"));
      const work = (async () => {
        await assertOwner();
        if (options.workspace.companyId !== input.companyId) throw new Error("workspace_source_company_mismatch");
        const sourceRoot = rootOf(options.workspace);
        if (sourceRoot) await assertCurrentWorkspaceSourceHeld(sourceRoot);
        const result = await prepareNestedWorkspaceImportsWithVerification({ ...options, db: input.db, storage: input.storage, signal }, verification);
        await assertOwner();
        return result;
      })().catch(error => { stop.abort(error); throw error; });
      current = work;
      return work.finally(() => { current = undefined; });
    },
    async close() {
      closed = true; stop.abort(new Error("nested_workspace_verifier_closed"));
      if (current) await Promise.allSettled([current]);
      proofs.clear();
    },
  };
}

export function prepareNestedWorkspaceImports(input: NestedVerificationInput): Promise<ImportedWorkspaceChild[]> {
  return prepareNestedWorkspaceImportsWithVerification(input);
}

async function prepareNestedWorkspaceImportsWithVerification(input: NestedVerificationInput, verification?: NestedVerification): Promise<ImportedWorkspaceChild[]> {
  const sourceRoot = rootOf(input.workspace);
  if (!sourceRoot || input.recordedChildren && !input.recordedChildren.length) return [];
  const root = await physicalPath(sourceRoot);
  const candidates = (await importedWorkspaceCandidates(input.db, input.workspace)).filter(row =>
    !input.recordedChildren || input.recordedChildren.some(child => child.operationId === row.operation.id));
  const covered: ImportedWorkspaceChild[] = [];
  const selected: typeof candidates = [];
  for (const { operation, snapshot, sourcePath } of candidates) {
    input.signal?.throwIfAborted();
    const relativePath = path.relative(root, sourcePath).split(path.sep).join("/");
    if (covered.some(item => relativePath === item.relativePath || relativePath.startsWith(`${item.relativePath}/`))) continue;
    const entry = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!entry) { if (input.recordedChildren) throw new Error("nested_workspace_source_changed"); continue; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("nested_workspace_source_changed");
    if (!verification) await verifyCoveredWorkspace({ ...input, sourcePath, snapshot, operationId: operation.id,
      expectedDigest: operation.metadata?.manifestDigest, depth: 0 });
    else selected.push({ operation, snapshot, sourcePath });
    covered.push({ workspaceId: snapshot.executionWorkspaceId, snapshotId: snapshot.id, operationId: operation.id,
      relativePath, manifestDigest: snapshot.manifestDigest! });
  }
  if (verification) {
    let next = 0, failure: unknown;
    const worker = async () => {
      while (!input.signal?.aborted && next < selected.length) {
        const { operation, snapshot, sourcePath } = selected[next++];
        try { await verifyCoveredWorkspace({ ...input, sourcePath, snapshot, operationId: operation.id,
          expectedDigest: operation.metadata?.manifestDigest, depth: 0 }, verification); }
        catch (error) { failure ??= error; verification.abort(error); }
      }
    };
    const peers = await Promise.allSettled(Array.from({ length: Math.min(2, selected.length) }, worker));
    for (const peer of peers) if (peer.status === "rejected") failure ??= peer.reason;
    if (failure) throw failure;
    input.signal?.throwIfAborted();
  }
  if (input.recordedChildren && !isDeepStrictEqual(covered, input.recordedChildren)) throw new Error("nested_workspace_scope_changed");
  return covered;
}

async function verifyCoveredWorkspace(input: {
  db: Db; storage: StorageService; sourcePath: string; snapshot: typeof executionWorkspaceSnapshots.$inferSelect;
  operationId: string; expectedDigest: unknown; scratch: string; signal?: AbortSignal; depth: number; gitSourceRoots?: string[];
}, verification?: NestedVerification) {
  input.signal?.throwIfAborted();
  if (input.depth > 32) throw new Error("nested_workspace_coverage_invalid");
  const { snapshot } = input;
  const reference = await getWorkspaceSnapshot(input.db, { companyId: snapshot.companyId,
    workspaceId: snapshot.executionWorkspaceId, snapshotId: snapshot.id });
  if (!reference || reference.manifestDigest !== input.expectedDigest || snapshot.sourceOperationId !== input.operationId)
    throw new Error("nested_workspace_snapshot_changed");
  const children = validateImportedWorkspaceChildren(snapshot.metadata?.importedWorkspaceChildren ?? []);
  const area = await fs.mkdtemp(path.join(input.scratch, "covered-"));
  for (const child of children) {
    const [saved] = await input.db.select({ operation: workspaceOperations, snapshot: executionWorkspaceSnapshots })
      .from(executionWorkspaceSnapshots).innerJoin(workspaceOperations, and(
        eq(workspaceOperations.companyId, executionWorkspaceSnapshots.companyId), eq(workspaceOperations.id, executionWorkspaceSnapshots.sourceOperationId),
      )).where(and(eq(executionWorkspaceSnapshots.companyId, snapshot.companyId), eq(executionWorkspaceSnapshots.id, child.snapshotId),
        eq(executionWorkspaceSnapshots.executionWorkspaceId, child.workspaceId), eq(workspaceOperations.id, child.operationId),
        eq(workspaceOperations.status, "succeeded"), eq(workspaceOperations.phase, "remote_workspace_migration"),
        inArray(executionWorkspaceSnapshots.status, ["committed", "superseded"])));
    const sourcePath = path.join(input.sourcePath, child.relativePath);
    if (!saved?.operation.cwd || await physicalPath(saved.operation.cwd) !== sourcePath) throw new Error("nested_workspace_coverage_invalid");
    await verifyCoveredWorkspace({ ...input, sourcePath, snapshot: saved.snapshot, operationId: child.operationId,
      expectedDigest: child.manifestDigest, scratch: area, depth: input.depth + 1 }, verification);
  }
  const archivePath = path.join(area, "saved.pcws"), restored = path.join(area, "restored");
  if (verification) await verification.immutable(reference, children, input.operationId, archivePath, restored);
  else {
    await loadWorkspaceSnapshotArchive({ storage: input.storage, reference, targetPath: archivePath, signal: input.signal });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir: restored, expectedManifestDigest: reference.manifestDigest, signal: input.signal });
  }
  const current = await captureRemoteWorkspaceDirectory({ cwd: input.sourcePath, archivePath: path.join(area, "current.pcws"),
    exclude: children.map(child => child.relativePath), gitSourceRoots: input.gitSourceRoots, signal: input.signal });
  if (current.manifestDigest !== reference.manifestDigest) throw new Error("nested_workspace_source_changed");
}
