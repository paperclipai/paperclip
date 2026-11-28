import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";

const turnsByRoutine = new Map<string, Promise<void>>();

export async function withRoutineDispatchLock<T>(db: Db, routineId: string, work: () => Promise<T>): Promise<T> {
  const previous = turnsByRoutine.get(routineId) ?? Promise.resolve();
  const result = previous.then(() => withDedicatedDbConnection(db, (lockDb) => lockDb.transaction(async (lock) => {
    const rows = await lock.execute<{ idle_timeout_ms: string | number | null }>(sql`select
      pg_advisory_xact_lock(hashtextextended(${`routine_dispatch:${routineId}`}, 0)),
      (select setting::bigint from pg_settings where name = 'idle_in_transaction_session_timeout') as idle_timeout_ms`);
    return withWorkspaceLockKeepalive(lock, Number(rows[0]?.idle_timeout_ms), work);
  })));
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  turnsByRoutine.set(routineId, settled);
  try {
    return await result;
  } finally {
    if (turnsByRoutine.get(routineId) === settled) turnsByRoutine.delete(routineId);
  }
}
