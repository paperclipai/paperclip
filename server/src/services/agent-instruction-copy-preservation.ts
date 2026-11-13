import { and, eq, isNotNull, not, notInArray, sql } from "drizzle-orm";
import { agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";

/** Terminal run status does not settle private edits. Only the copy owner's
 * save/resolution or confirmed stopped no-save cleanup releases local bytes. */
export async function hasUnsettledLocalInstructionCopies(db: Pick<Db, "select">,
  scope?: { companyId: string; agentId?: string }): Promise<boolean> {
  return (await db.select({ runId: copies.runId }).from(copies).where(and(
    scope ? eq(copies.companyId, scope.companyId) : undefined,
    scope?.agentId ? eq(copies.agentId, scope.agentId) : undefined,
    eq(copies.location, "local"), notInArray(copies.state, ["saved", "unchanged", "resolved", "superseded"]),
    not(and(eq(copies.state, "unavailable"), isNotNull(copies.processStoppedAt),
      sql`coalesce(${copies.receipt}->>'schema', '') = 'paperclip.agent-files.v1'`,
      sql`coalesce(${copies.receipt}->>'cleanupPending', '') = 'false'`)!),
  )).limit(1)).length > 0;
}
