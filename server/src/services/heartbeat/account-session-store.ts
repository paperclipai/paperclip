import { agentAccountSessions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

type AccountSessionKey = { companyId: string; sessionId: string; sessionIdentity: string };
type AccountSessionState = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
  lastError: string | null;
};

export function accountSessionStore(db: Db) {
  return {
    async get(key: AccountSessionKey) {
      const [row] = await db.select().from(agentAccountSessions).where(and(
        eq(agentAccountSessions.companyId, key.companyId),
        eq(agentAccountSessions.sessionId, key.sessionId),
        eq(agentAccountSessions.sessionIdentity, key.sessionIdentity),
      ));
      return row;
    },
    async upsert(key: AccountSessionKey, state: AccountSessionState) {
      const [row] = await db.insert(agentAccountSessions).values({ ...key, ...state }).onConflictDoUpdate({
        target: [agentAccountSessions.companyId, agentAccountSessions.sessionId, agentAccountSessions.sessionIdentity],
        set: { ...state, updatedAt: new Date() },
      }).returning();
      return row;
    },
  };
}
