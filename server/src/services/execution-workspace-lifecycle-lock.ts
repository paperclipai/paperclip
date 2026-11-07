import { executionWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { workspaceSourceIdentities, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function acquireExecutionWorkspaceLifecycleLock(
  tx: Transaction,
  workspaceId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`,
  );
}

export async function withExecutionWorkspaceLifecycleLock<T>(
  db: Db,
  workspaceId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const [source] = await db.select({ companyId: executionWorkspaces.companyId, projectId: executionWorkspaces.projectId,
    providerType: executionWorkspaces.providerType, sourceIssueId: executionWorkspaces.sourceIssueId, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
  const sourceRoots = source && (source.cwd ?? source.providerRef)
    ? await workspaceSourceIdentities(source.companyId, (source.cwd ?? source.providerRef)!) : null;
  const projectIds = [...new Set([...(sourceRoots?.projectIds ?? []),
    source && ["local_fs", "git_worktree"].includes(source.providerType) ? source.projectId : null,
  ].filter((id): id is string => Boolean(id)))].sort();
  const issueIds = [...new Set([...(sourceRoots?.issueIds ?? []),
    source && ["local_fs", "git_worktree"].includes(source.providerType) ? source.sourceIssueId : null,
  ].filter((id): id is string => Boolean(id)))].sort();
  const workWithLifecycle = () => withDedicatedDbConnection(db, (connection) =>
    connection.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
      if ((projectIds.length || issueIds.length) && source) {
        const [fresh] = await tx.select({ companyId: executionWorkspaces.companyId, projectId: executionWorkspaces.projectId,
          providerType: executionWorkspaces.providerType, sourceIssueId: executionWorkspaces.sourceIssueId, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
        const freshRoots = fresh && (fresh.cwd ?? fresh.providerRef)
          ? await workspaceSourceIdentities(fresh.companyId, (fresh.cwd ?? fresh.providerRef)!) : null;
        if (!fresh || fresh.companyId !== source.companyId || fresh.projectId !== source.projectId
          || fresh.providerType !== source.providerType || fresh.sourceIssueId !== source.sourceIssueId || !isDeepStrictEqual(freshRoots, sourceRoots)) {
          throw new Error("workspace_source_scope_changed");
        }
      }
      const rows = await tx.execute(
        sql`select setting::bigint as idle_timeout_ms from pg_settings where name = 'idle_in_transaction_session_timeout'`,
      );
      return withWorkspaceLockKeepalive(
        tx,
        Number(rows[0]?.idle_timeout_ms),
        () => work(tx),
      );
    }),
  );
  return (projectIds.length || issueIds.length) && source
    ? withWorkspaceSourceLocks(db, { companyId: source.companyId, projectIds, issueIds }, workWithLifecycle)
    : workWithLifecycle();
}

export async function tryAcquireExecutionWorkspaceLifecycleLock(tx: Transaction, workspaceId: string) {
  const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0)) as acquired`);
  return rows[0]?.acquired === true;
}
