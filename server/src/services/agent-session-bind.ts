import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";

/**
 * Bound-run-id TTL: a session binding older than this is treated as stale
 * and ignored by `auth.ts`. The TTL is intentionally generous (default 6h) so
 * a single WS session can survive long-running agent runs (some adaptive
 * suites run >1h) without the binding expiring mid-run. The harness clears
 * the binding when the run completes, so this is a backstop, not the
 * primary cleanup path.
 */
export const SESSION_BOUND_RUN_ID_TTL_MS = 6 * 60 * 60 * 1000;

export function isSessionBoundRunIdFresh(boundAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!boundAt) return false;
  const elapsed = now.getTime() - boundAt.getTime();
  return elapsed >= 0 && elapsed < SESSION_BOUND_RUN_ID_TTL_MS;
}

export async function bindSessionRunId(
  db: Db,
  input: { keyId: string; runId: string; boundAt?: Date },
): Promise<void> {
  await db
    .update(agentApiKeys)
    .set({
      sessionBoundRunId: input.runId,
      sessionBoundAt: input.boundAt ?? new Date(),
    })
    .where(and(eq(agentApiKeys.id, input.keyId), isNull(agentApiKeys.revokedAt)));
}

export async function clearSessionRunId(
  db: Db,
  input: { keyId: string; runId?: string },
): Promise<void> {
  // Only clear if the bound runId matches — guards against clearing a newer
  // binding from a concurrent run that took over the same key.
  const conditions = input.runId
    ? and(
        eq(agentApiKeys.id, input.keyId),
        eq(agentApiKeys.sessionBoundRunId, input.runId),
      )
    : eq(agentApiKeys.id, input.keyId);

  await db
    .update(agentApiKeys)
    .set({ sessionBoundRunId: null, sessionBoundAt: null })
    .where(conditions);
}
