import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatMessages, chatThreads, issues } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";
import { heartbeatService } from "./heartbeat.js";

export interface CreateThread {
  issueId?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateMessage {
  role: "user" | "assistant" | "system";
  body: string;
  metadata?: Record<string, unknown> | null;
}

export function chatService(db: Db) {
  const heartbeat = heartbeatService(db);

  async function listThreads(companyId: string, opts?: { issueId?: string; status?: string }) {
    const conditions: SQL[] = [eq(chatThreads.companyId, companyId)];
    if (opts?.issueId) conditions.push(eq(chatThreads.issueId, opts.issueId));
    if (opts?.status) conditions.push(eq(chatThreads.status, opts.status));
    return db
      .select()
      .from(chatThreads)
      .where(and(...conditions))
      .orderBy(desc(chatThreads.updatedAt));
  }

  async function getThread(threadId: string) {
    return db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .then((rows) => rows[0] ?? null);
  }

  async function createThread(
    companyId: string,
    data: CreateThread,
    actor: { agentId?: string; userId?: string },
  ) {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        companyId,
        issueId: data.issueId ?? null,
        title: data.title ?? null,
        metadata: data.metadata ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();

    publishLiveEvent({
      companyId,
      type: "chat.thread.created",
      payload: { threadId: thread.id },
    });
    return thread;
  }

  async function updateThread(threadId: string, patch: { title?: string | null; status?: string; issueId?: string | null }) {
    const [updated] = await db
      .update(chatThreads)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(chatThreads.id, threadId))
      .returning();
    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "chat.thread.updated",
        payload: { threadId: updated.id, status: updated.status },
      });
    }
    return updated ?? null;
  }

  async function listMessages(threadId: string, opts?: { limit?: number }) {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(opts?.limit ?? 200);
  }

  async function createMessage(
    companyId: string,
    threadId: string,
    data: CreateMessage,
    actor: { agentId?: string; userId?: string },
  ) {
    const [message] = await db
      .insert(chatMessages)
      .values({
        companyId,
        threadId,
        authorAgentId: actor.agentId ?? null,
        authorUserId: actor.userId ?? null,
        role: data.role,
        body: data.body,
        metadata: data.metadata ?? null,
      })
      .returning();

    await db
      .update(chatThreads)
      .set({ updatedAt: new Date() })
      .where(eq(chatThreads.id, threadId));

    publishLiveEvent({
      companyId,
      type: "chat.message.created",
      payload: { threadId, messageId: message.id, role: data.role },
    });

    if (data.role === "user") {
      await wakeAgentForChat(companyId, threadId, message.id, actor);
    }
    return message;
  }

  async function wakeAgentForChat(
    companyId: string,
    threadId: string,
    messageId: string,
    actor: { agentId?: string; userId?: string },
  ) {
    const thread = await getThread(threadId);
    if (!thread?.issueId) return;
    const [issue] = await db.select().from(issues).where(eq(issues.id, thread.issueId));
    if (!issue?.assigneeAgentId) return;

    await heartbeat.wakeup(issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "chat_message_received",
      payload: { threadId, messageId, issueId: thread.issueId },
      requestedByActorType: actor.userId ? "user" : "agent",
      requestedByActorId: actor.userId ?? actor.agentId ?? null,
      contextSnapshot: {
        threadId,
        messageId,
        issueId: thread.issueId,
        wakeReason: "chat_message_received",
        source: "chat.message",
      },
    });
  }

  return {
    listThreads,
    getThread,
    createThread,
    updateThread,
    listMessages,
    createMessage,
  };
}
