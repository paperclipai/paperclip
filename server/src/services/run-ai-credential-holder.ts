import { and, eq, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** The grant whose token a run received. Written by the credential service under the company credential lock. */
export const AI_CREDENTIAL_HOLDER_KEY = "aiCredentialHolder";
const KEPT_KEYS = [AI_CREDENTIAL_HOLDER_KEY, "aiConnection"] as const;

/**
 * A context snapshot for a write that replaces the whole snapshot of a run
 * from an earlier read. The run may have received its AI credential since
 * that read. The renewal of a Claude subscription finds the holders of a
 * token by these keys, so the write keeps the values the row has now.
 */
export function runContextKeepingAiCredentialHolder(next: Record<string, unknown>): SQL {
  const kept = KEPT_KEYS.map(key => sql`case when jsonb_exists(${heartbeatRuns.contextSnapshot}, ${key})
    then jsonb_build_object(${key}::text, ${heartbeatRuns.contextSnapshot} -> ${key}) else '{}'::jsonb end`);
  return sql`${JSON.stringify(next)}::jsonb || ${sql.join(kept, sql` || `)}`;
}

/** In a run's `aiConnection`: the identity of a token that was prepared for the run while its live runner still held an earlier one. */
export const AI_PREPARED_IDENTITY_KEY = "preparedIdentity";

/**
 * Restart recovery retired the runner of this run and launches a replacement
 * with the newly prepared credential. Record that identity as the one the
 * run's process holds, so a later rejection is attributed to the right token.
 */
export async function recordReplacementRunnerCredential(db: Db, run: { companyId: string; runId: string }): Promise<void> {
  const prepared = sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' -> ${AI_PREPARED_IDENTITY_KEY}`;
  await db.update(heartbeatRuns)
    .set({ contextSnapshot: sql`jsonb_set(${heartbeatRuns.contextSnapshot} #- ${`{aiConnection,${AI_PREPARED_IDENTITY_KEY}}`}::text[], '{aiConnection,identity}', ${prepared})` })
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.runId), sql`jsonb_typeof(${prepared}) = 'string'`));
}
