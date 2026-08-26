import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export async function lockHeartbeatRunEventSequence(
  executor: Pick<Db, "execute">,
  runId: string,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`heartbeat-run-events:${runId}`}, 0))`,
  );
}
