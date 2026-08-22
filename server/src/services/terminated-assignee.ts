import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

/**
 * A terminated agent can never run again: its API keys are revoked and it can
 * never be assigned new work. Anything it still owns — issues, routines — is
 * therefore unowned in practice, and must stay reclaimable by the rest of the
 * company instead of being frozen forever behind an ownership check.
 */
export async function isTerminatedAgentId(db: Db, agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  const row = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  return row?.status === "terminated";
}
