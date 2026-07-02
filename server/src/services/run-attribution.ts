import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

type DbReader = Pick<Db, "select">;

export async function coerceExistingHeartbeatRunId(
  db: DbReader,
  runId: string | null | undefined,
  companyId?: string | null,
) {
  if (!runId) return null;

  const conditions = companyId
    ? and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))
    : eq(heartbeatRuns.id, runId);
  const run = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(conditions)
    .then((rows) => rows[0] ?? null);

  return run?.id ?? null;
}
