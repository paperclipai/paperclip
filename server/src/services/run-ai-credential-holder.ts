import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

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
