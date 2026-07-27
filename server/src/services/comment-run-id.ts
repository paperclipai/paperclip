import { and, eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/**
 * Resolve a `created_by_run_id` safe for any FK referencing `heartbeat_runs`;
 * returns null for missing/invalid/nonexistent ids so a client-forwarded run
 * id can never 500 an insert with a Postgres 23503 violation (#9489).
 *
 * A run id reaching this point may be entirely client-controlled (e.g. a
 * board/session actor's raw `X-Paperclip-Run-Id` header, which middleware
 * does not validate) — every insert with a `created_by_run_id` FK column
 * must resolve through this rather than trusting the actor's run id shape.
 */
export async function resolveCreatedByRunId(
  dbOrTx: any,
  companyId: string,
  runId: string | null | undefined,
): Promise<string | null> {
  const normalized = typeof runId === "string" ? runId.trim() : "";
  if (!normalized || !isUuidLike(normalized)) return null;
  const existing = await dbOrTx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, normalized), eq(heartbeatRuns.companyId, companyId)))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  return existing?.id ?? null;
}
