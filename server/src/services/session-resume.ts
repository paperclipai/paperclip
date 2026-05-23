import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workSessions, sessionSnapshots } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface Task {
  id: string;
  file: string;
  line: number;
  content: string;
  priority: "high" | "medium" | "low";
  type: "todo" | "fixme" | "hack" | "bug";
}

export interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  timestamp: Date;
}

export interface SessionResume {
  sessionId: string;
  branch: string;
  lastActive: Date;
  duration: number;
  unfinishedTasks: Task[];
  recentChanges: FileChange[];
  filesToReopen: string[];
  summary: string;
  contextScore: number;
}

export function sessionResumeService(db: Db) {
  return {
    async startSession(
      companyId: string,
      agentId?: string,
      branch?: string
    ) {
      const session = await db
        .insert(workSessions)
        .values({
          companyId,
          agentId,
          gitBranch: branch,
          status: "active",
          metadata: { version: "1.0.0" },
        })
        .returning();
      
      logger.info({ sessionId: session[0].id, companyId }, "Session started");
      return session[0];
    },

    async captureSnapshot(
      sessionId: string,
      data: {
        branch?: string;
        openFiles?: string[];
        tasks?: Task[];
        changes?: FileChange[];
        summary?: string;
        contextScore?: number;
      }
    ) {
      const snapshot = await db
        .insert(sessionSnapshots)
        .values({
          sessionId,
          gitBranch: data.branch,
          openFiles: data.openFiles,
          unfinishedTasks: data.tasks,
          recentChanges: data.changes,
          summary: data.summary,
          contextScore: data.contextScore,
        })
        .returning();

      logger.info({ sessionId, snapshotId: snapshot[0].id }, "Snapshot captured");
      return snapshot[0];
    },

    async endSession(sessionId: string) {
      const now = new Date();
      const session = await db.query.workSessions.findFirst({
        where: eq(workSessions.id, sessionId),
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const duration = Math.floor(
        (now.getTime() - session.startTime.getTime()) / 1000
      );

      const updated = await db
        .update(workSessions)
        .set({
          endTime: now,
          status: "ended",
          duration,
          updatedAt: now,
        })
        .where(eq(workSessions.id, sessionId))
        .returning();

      logger.info({ sessionId, duration }, "Session ended");
      return updated[0];
    },

    async getLastSessionResume(
      companyId: string,
      agentId?: string
    ): Promise<SessionResume | null> {
      const conditions = [eq(workSessions.companyId, companyId)];
      if (agentId) {
        conditions.push(eq(workSessions.agentId, agentId));
      }

      const session = await db.query.workSessions.findFirst({
        where: and(...conditions),
        orderBy: desc(workSessions.endTime || workSessions.startTime),
      });

      if (!session) return null;

      const snapshots = await db.query.sessionSnapshots.findMany({
        where: eq(sessionSnapshots.sessionId, session.id),
        orderBy: desc(sessionSnapshots.timestamp),
        limit: 1,
      });

      const lastSnapshot = snapshots[0];
      if (!lastSnapshot) return null;

      return {
        sessionId: session.id,
        branch: lastSnapshot.gitBranch || session.gitBranch || "",
        lastActive: session.endTime || new Date(),
        duration: session.duration || 0,
        unfinishedTasks: (lastSnapshot.unfinishedTasks as Task[]) || [],
        recentChanges: (lastSnapshot.recentChanges as FileChange[]) || [],
        filesToReopen: (lastSnapshot.openFiles as string[]) || [],
        summary: lastSnapshot.summary || session.summary || "",
        contextScore: lastSnapshot.contextScore || 0,
      };
    },

    async getActivitySummary(companyId: string, days: number = 7) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const sessions = await db.query.workSessions.findMany({
        where: and(
          eq(workSessions.companyId, companyId),
        ),
      });

      const totalDuration = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
      const avgTasks = sessions.length > 0 ? Math.round(totalDuration / sessions.length) : 0;

      return {
        totalSessions: sessions.length,
        totalDuration,
        averageDuration: avgTasks,
        sessionsThisWeek: sessions.length,
      };
    },
  };
}
