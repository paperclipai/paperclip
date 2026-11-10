import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { idleChatHistoryChecks } from "../../services/chat-channels/idle-history-proof.js";

/** Scope the actual shared predicate to a real producer's receipt. Other pending
 * fixture work remains independently observable through its owning gates. */
export async function chatHistoryActionBlocks(db: Db, actionId: string): Promise<boolean> {
  const check = idleChatHistoryChecks.find(check => check.reason === "chat_actions")!;
  const [row] = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (${sql.raw(check.query)} AND a.id = ${actionId}::uuid) AS blocked`);
  return row.blocked;
}
