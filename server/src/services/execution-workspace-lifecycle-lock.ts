import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
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

export function withExecutionWorkspaceLifecycleLock<T>(
  db: Db,
  workspaceId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withDedicatedDbConnection(db, (connection) =>
    connection.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
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
}
