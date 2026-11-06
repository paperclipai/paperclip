import { AsyncLocalStorage } from "node:async_hooks";
import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { canonicalRepositoryRoot } from "./execution-workspace-source-roots.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";

type SourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SourceLockScope = { db: Db; companyId: string; keys: Set<string>; transaction: SourceTransaction };
const sourceLocks = new AsyncLocalStorage<SourceLockScope>();
export class IsolatedRepositorySourceBusy extends Error {}

export function withIsolatedRepositorySourceLock<T>(db: Db, companyId: string, issueId: string,
  action: () => Promise<T>, tryOnly = false): Promise<T> {
  return withWorkspaceSourceLocks(db, { companyId, issueIds: [issueId] }, action, tryOnly);
}

export async function withWorkspaceSourceLocks<T>(db: Db,
  input: { companyId: string; issueIds?: readonly string[]; projectIds?: readonly string[] },
  action: (transaction: SourceTransaction) => Promise<T>, tryOnly = false): Promise<T> {
  const keys = [...new Set([
    ...(input.issueIds ?? []).map(id => `isolated_repository_source:${input.companyId}:${id}`),
    ...(input.projectIds ?? []).map(id => `managed_project_source:${input.companyId}:${id}`),
  ])].sort();
  if (keys.length > 128) throw new Error("workspace_source_scope_limit");
  const held = sourceLocks.getStore();
  const acquire = async (scope: SourceLockScope, nonblocking: boolean) => {
    for (const key of keys) {
      if (scope.keys.has(key)) continue;
      const lock = nonblocking ? sql`pg_try_advisory_xact_lock(hashtextextended(${key}, 0))`
        : sql`pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const rows = await scope.transaction.execute(sql`select ${lock} as acquired`);
      if (nonblocking && !rows[0]?.acquired) throw new IsolatedRepositorySourceBusy("workspace_source_busy");
      scope.keys.add(key);
    }
  };
  if (held?.db === db) {
    if (new Set([...held.keys, ...keys]).size > 128) throw new Error("workspace_source_scope_limit");
    if (held.companyId !== input.companyId) throw new Error("workspace_source_company_mismatch");
    const onlyProjectKeys = keys.every(key => key.startsWith("managed_project_source:"));
    const alreadyHasProject = [...held.keys].some(key => key.startsWith("managed_project_source:"));
    await acquire(held, !onlyProjectKeys || alreadyHasProject);
    return action(held.transaction);
  }
  return withDedicatedDbConnection(db, connection => connection.transaction(async transaction => {
    const scope = { db, companyId: input.companyId, transaction, keys: new Set<string>() };
    await acquire(scope, tryOnly);
    const rows = await transaction.execute(sql`select setting::bigint as idle_timeout_ms from pg_settings where name = 'idle_in_transaction_session_timeout'`);
    return withWorkspaceLockKeepalive(transaction, Number(rows[0]?.idle_timeout_ms),
      () => sourceLocks.run(scope, () => action(transaction)));
  }));
}

export async function managedProjectSourceIdentity(companyId: string, cwd: string): Promise<string | null> {
  const root = await canonicalRepositoryRoot(path.join(resolvePaperclipInstanceRoot(), "projects"));
  const target = await canonicalRepositoryRoot(cwd);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const [owner, projectId] = relative.split(path.sep);
  if (owner !== companyId) throw new Error("workspace_source_company_mismatch");
  return projectId && /^[a-f0-9-]{36}$/.test(projectId) ? projectId : null;
}

export async function isolatedTaskSourceIdentity(companyId: string, cwd: string): Promise<string | null> {
  const root = await canonicalRepositoryRoot(resolvePaperclipInstanceRoot());
  const relative = path.relative(root, await canonicalRepositoryRoot(cwd)).split(path.sep);
  if (!["isolated-workspaces", "isolated-workspace-attempts"].includes(relative[0])) return null;
  if (relative[1] !== companyId) throw new Error("workspace_source_company_mismatch");
  return relative[2] && /^[a-f0-9-]{36}$/.test(relative[2]) ? relative[2] : null;
}

export async function retainManagedProjectSource(db: Db, companyId: string, cwd: string): Promise<void> {
  const projectId = await managedProjectSourceIdentity(companyId, cwd);
  if (!projectId) return;
  if (sourceLocks.getStore()?.db !== db) throw new Error("workspace_source_admission_scope_required");
  await withWorkspaceSourceLocks(db, { companyId, projectIds: [projectId] }, async () => undefined, true);
}

export async function retainCurrentWorkspaceSource(cwd: string): Promise<void> {
  const scope = sourceLocks.getStore();
  if (!scope) return;
  const instance = await canonicalRepositoryRoot(resolvePaperclipInstanceRoot());
  const task = path.relative(instance, await canonicalRepositoryRoot(cwd)).split(path.sep);
  if (["isolated-workspaces", "isolated-workspace-attempts"].includes(task[0]) && task.length >= 3) {
    const issueId = await isolatedTaskSourceIdentity(scope.companyId, cwd);
    if (issueId) await withWorkspaceSourceLocks(scope.db, { companyId: scope.companyId, issueIds: [issueId] }, async () => undefined, true);
    return;
  }
  const root = await canonicalRepositoryRoot(path.join(resolvePaperclipInstanceRoot(), "projects"));
  const target = await canonicalRepositoryRoot(cwd), relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const [companyId, projectId] = relative.split(path.sep);
  if (!companyId || !projectId || !/^[a-f0-9-]{36}$/.test(companyId) || !/^[a-f0-9-]{36}$/.test(projectId)) return;
  await retainManagedProjectSource(scope.db, companyId, cwd);
}
