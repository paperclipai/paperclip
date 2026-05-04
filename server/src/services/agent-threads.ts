import type { Db } from "@paperclipai/db";
import { agentThreadMessages, agentThreadReads, agentThreads } from "@paperclipai/db";
import { and, asc, desc, eq } from "drizzle-orm";

const AGENT_THREAD_INACTIVITY_MS = 12 * 60 * 60 * 1000;
type AgentThreadTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isThreadStale(lastActivityAt: Date | string, now: Date) {
  return now.getTime() - new Date(lastActivityAt).getTime() >= AGENT_THREAD_INACTIVITY_MS;
}

export function agentThreadService(db: Db) {
  async function ensureActiveThreadTx(
    tx: AgentThreadTx,
    input: { companyId: string; agentId: string; now: Date },
  ) {
    const [existing] = await tx
      .select()
      .from(agentThreads)
      .where(
        and(
          eq(agentThreads.companyId, input.companyId),
          eq(agentThreads.agentId, input.agentId),
          eq(agentThreads.status, "active"),
        ),
      )
      .orderBy(desc(agentThreads.createdAt), desc(agentThreads.id))
      .limit(1);

    if (existing && !isThreadStale(existing.lastActivityAt, input.now)) {
      return existing;
    }

    if (existing) {
      await tx
        .update(agentThreads)
        .set({
          status: "archived",
          archivedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(agentThreads.id, existing.id));
    }

    const [created] = await tx
      .insert(agentThreads)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        status: "active",
        lastActivityAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();

    return created;
  }

  return {
    getActiveThread: async (input: { companyId: string; agentId: string }) => {
      // Pure read: returns current active thread without creating/archiving
      const [thread] = await db
        .select()
        .from(agentThreads)
        .where(
          and(
            eq(agentThreads.companyId, input.companyId),
            eq(agentThreads.agentId, input.agentId),
            eq(agentThreads.status, "active"),
          ),
        )
        .orderBy(desc(agentThreads.createdAt), desc(agentThreads.id))
        .limit(1);
      return thread ?? null;
    },

    ensureActiveThread: async (input: { companyId: string; agentId: string; now?: Date }) => {
      const now = input.now ?? new Date();
      return db.transaction((tx) => ensureActiveThreadTx(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        now,
      }));
    },

    postUserMessage: async (input: {
      companyId: string;
      agentId: string;
      authorUserId: string;
      body: string;
      now?: Date;
    }) => {
      const now = input.now ?? new Date();
      return db.transaction(async (tx) => {
        const thread = await ensureActiveThreadTx(tx, {
          companyId: input.companyId,
          agentId: input.agentId,
          now,
        });

        const [message] = await tx
          .insert(agentThreadMessages)
          .values({
            threadId: thread.id,
            companyId: input.companyId,
            role: "user",
            authorUserId: input.authorUserId,
            authorAgentId: null,
            producingHeartbeatRunId: null,
            body: input.body,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [updatedThread] = await tx
          .update(agentThreads)
          .set({
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(agentThreads.id, thread.id))
          .returning();

        return {
          thread: updatedThread ?? thread,
          message,
        };
      });
    },

    postAssistantMessage: async (input: {
      companyId: string;
      threadId: string;
      authorAgentId: string;
      body: string;
      producingHeartbeatRunId?: string | null;
      now?: Date;
    }) => {
      const now = input.now ?? new Date();
      return db.transaction(async (tx) => {
        const [thread] = await tx
          .select()
          .from(agentThreads)
          .where(
            and(
              eq(agentThreads.companyId, input.companyId),
              eq(agentThreads.id, input.threadId),
              eq(agentThreads.status, "active"),
            ),
          )
          .limit(1);

        if (!thread) {
          // Thread archived or not found — skip gracefully
          return null;
        }

        const [message] = await tx
          .insert(agentThreadMessages)
          .values({
            threadId: thread.id,
            companyId: input.companyId,
            role: "assistant",
            authorUserId: null,
            authorAgentId: input.authorAgentId,
            producingHeartbeatRunId: input.producingHeartbeatRunId ?? null,
            body: input.body,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();

        if (!message) {
          // Duplicate producing run — skip silently
          return null;
        }

        await tx
          .update(agentThreads)
          .set({
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(agentThreads.id, thread.id));

        return message;
      });
    },

    listMessages: async (input: { companyId: string; agentId: string; now?: Date }) => {
      return db.transaction(async (tx) => {
        // Pure read: fetch current active thread without creating/archiving
        const [thread] = await tx
          .select()
          .from(agentThreads)
          .where(
            and(
              eq(agentThreads.companyId, input.companyId),
              eq(agentThreads.agentId, input.agentId),
              eq(agentThreads.status, "active"),
            ),
          )
          .orderBy(desc(agentThreads.createdAt), desc(agentThreads.id))
          .limit(1);

        if (!thread) {
          return { thread: null, messages: [] };
        }

        const messages = await tx
          .select()
          .from(agentThreadMessages)
          .where(
            and(
              eq(agentThreadMessages.companyId, input.companyId),
              eq(agentThreadMessages.threadId, thread.id),
            ),
          )
          .orderBy(asc(agentThreadMessages.createdAt), asc(agentThreadMessages.id));
        return { thread, messages };
      });
    },

    markRead: async (input: {
      companyId: string;
      agentId: string;
      userId: string;
      lastReadMessageId?: string | null;
      now?: Date;
    }) => {
      const now = input.now ?? new Date();
      return db.transaction(async (tx) => {
        // Plain read: do not create/archive threads on read-receipt
        const [thread] = await tx
          .select()
          .from(agentThreads)
          .where(
            and(
              eq(agentThreads.companyId, input.companyId),
              eq(agentThreads.agentId, input.agentId),
              eq(agentThreads.status, "active"),
            ),
          )
          .orderBy(desc(agentThreads.createdAt), desc(agentThreads.id))
          .limit(1);
        if (!thread) return null;
        const [readState] = await tx
          .insert(agentThreadReads)
          .values({
            threadId: thread.id,
            companyId: input.companyId,
            userId: input.userId,
            lastReadMessageId: input.lastReadMessageId ?? null,
            lastReadAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              agentThreadReads.companyId,
              agentThreadReads.threadId,
              agentThreadReads.userId,
            ],
            set: {
              lastReadMessageId: input.lastReadMessageId ?? null,
              lastReadAt: now,
              updatedAt: now,
            },
          })
          .returning();
        return { thread, readState };
      });
    },
  };
}
