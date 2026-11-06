import { executionWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { isolatedTaskSourceIdentity, managedProjectSourceIdentity, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
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
  const [source] = await db.select({ companyId: executionWorkspaces.companyId, cwd: executionWorkspaces.cwd,
    providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
  const projectId = source && (source.cwd ?? source.providerRef)
    ? await managedProjectSourceIdentity(source.companyId, (source.cwd ?? source.providerRef)!) : null;
  const issueId = source && (source.cwd ?? source.providerRef)
    ? await isolatedTaskSourceIdentity(source.companyId, (source.cwd ?? source.providerRef)!) : null;
  const workWithLifecycle = () => withDedicatedDbConnection(db, (connection) =>
    connection.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
      if ((projectId || issueId) && source) {
        const [fresh] = await tx.select({ companyId: executionWorkspaces.companyId, cwd: executionWorkspaces.cwd,
          providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
        if (!fresh || fresh.companyId !== source.companyId || !(fresh.cwd ?? fresh.providerRef)
          || await managedProjectSourceIdentity(fresh.companyId, (fresh.cwd ?? fresh.providerRef)!) !== projectId
          || await isolatedTaskSourceIdentity(fresh.companyId, (fresh.cwd ?? fresh.providerRef)!) !== issueId) {
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
  return (projectId || issueId) && source
    ? withWorkspaceSourceLocks(db, { companyId: source.companyId, projectIds: projectId ? [projectId] : [], issueIds: issueId ? [issueId] : [] }, workWithLifecycle)
    : workWithLifecycle();
}

export async function tryAcquireExecutionWorkspaceLifecycleLock(tx: Transaction, workspaceId: string) {
  const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0)) as acquired`);
  return rows[0]?.acquired === true;
}
