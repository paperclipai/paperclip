import type { Db } from "@paperclipai/db";
import { sparringSessions, sparringParticipants, sparringTurns } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import type { SparringSessionConfig } from "@paperclipai/shared";

export function sparringService(db: Db) {
  return {
    createSession: async (input: {
      companyId: string;
      issueId: string;
      runId: string | null;
      coordinatorAgentId: string;
      topic: string;
      participantAgentId: string;
      participantRole?: string;
      config?: SparringSessionConfig;
    }) => {
      return await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(sparringSessions)
          .values({
            companyId: input.companyId,
            issueId: input.issueId,
            runId: input.runId,
            coordinatorAgentId: input.coordinatorAgentId,
            topic: input.topic,
            status: "active",
            config: input.config ?? { maxRounds: 5, totalTimeoutSec: 600, turnTimeoutSec: 120 },
          })
          .returning();

        const [participant] = await tx
          .insert(sparringParticipants)
          .values({
            sessionId: session.id,
            agentId: input.participantAgentId,
            role: input.participantRole ?? null,
            status: "invited",
          })
          .returning();

        return { session, participant };
      });
    },

    getSession: async (sessionId: string) => {
      const [session] = await db
        .select()
        .from(sparringSessions)
        .where(eq(sparringSessions.id, sessionId));
      if (!session) return null;

      const participants = await db
        .select()
        .from(sparringParticipants)
        .where(eq(sparringParticipants.sessionId, sessionId));

      return { ...session, participants };
    },

    getActiveSessionForIssue: async (issueId: string) => {
      const [session] = await db
        .select()
        .from(sparringSessions)
        .where(and(eq(sparringSessions.issueId, issueId), eq(sparringSessions.status, "active")));
      return session ?? null;
    },

    recordTurn: async (input: {
      sessionId: string;
      agentId: string;
      roundNumber: number;
      turnNumber: number;
      role: string;
      content: string;
      tokenCount?: number;
      durationMs?: number;
    }) => {
      const [turn] = await db
        .insert(sparringTurns)
        .values({
          sessionId: input.sessionId,
          agentId: input.agentId,
          roundNumber: input.roundNumber,
          turnNumber: input.turnNumber,
          role: input.role,
          content: input.content,
          tokenCount: input.tokenCount ?? null,
          durationMs: input.durationMs ?? null,
        })
        .returning();
      return turn;
    },

    listTurns: async (sessionId: string) => {
      return await db
        .select()
        .from(sparringTurns)
        .where(eq(sparringTurns.sessionId, sessionId))
        .orderBy(sparringTurns.turnNumber);
    },

    completeSession: async (sessionId: string, summary: string) => {
      const [updated] = await db
        .update(sparringSessions)
        .set({
          status: "completed",
          summary,
          completedAt: new Date(),
        })
        .where(and(eq(sparringSessions.id, sessionId), eq(sparringSessions.status, "active")))
        .returning();
      if (!updated) return null;

      await db
        .update(sparringParticipants)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(sparringParticipants.sessionId, sessionId));

      return updated;
    },

    abortSession: async (sessionId: string, reason?: string) => {
      const [updated] = await db
        .update(sparringSessions)
        .set({
          status: "aborted",
          summary: reason ?? "Session aborted",
          completedAt: new Date(),
        })
        .where(and(eq(sparringSessions.id, sessionId), eq(sparringSessions.status, "active")))
        .returning();
      return updated ?? null;
    },
  };
}
