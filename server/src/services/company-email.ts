import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyEmailSettings } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "company-email" });

const AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";

// ---------------------------------------------------------------------------
// AgentMail API client (thin wrapper)
// ---------------------------------------------------------------------------

async function agentmailFetch<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${AGENTMAIL_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
    throw new Error(`AgentMail API error (${res.status}): ${errorText}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMailInbox {
  inbox_id: string;
  email: string;
  display_name?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMailMessage {
  message_id: string;
  thread_id: string;
  inbox_id: string;
  from_: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    attachment_id: string;
    filename: string;
    content_type: string;
    size: number;
  }>;
  labels?: string[];
  created_at: string;
}

export interface AgentMailThread {
  thread_id: string;
  subject: string;
  messages: AgentMailMessage[];
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMailSendResult {
  message_id: string;
  thread_id: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function companyEmailService(db: Db) {
  async function getSettings(companyId: string) {
    const [settings] = await db
      .select()
      .from(companyEmailSettings)
      .where(eq(companyEmailSettings.companyId, companyId));
    return settings ?? null;
  }

  async function requireApiKey(companyId: string): Promise<string> {
    const settings = await getSettings(companyId);
    if (!settings?.agentmailApiKey) {
      throw new Error("AgentMail API key not configured. Go to Company Settings to set it up.");
    }
    return settings.agentmailApiKey;
  }

  return {
    /** Get email settings for a company */
    getSettings,

    /** Save/update email settings */
    saveSettings: async (
      companyId: string,
      data: {
        agentmailApiKey?: string | null;
        agentmailInboxId?: string | null;
        agentmailEmail?: string | null;
        agentmailDisplayName?: string | null;
        enabled?: boolean;
      },
    ) => {
      const existing = await getSettings(companyId);
      if (existing) {
        const [updated] = await db
          .update(companyEmailSettings)
          .set({
            ...data,
            updatedAt: new Date(),
          })
          .where(eq(companyEmailSettings.companyId, companyId))
          .returning();
        return updated;
      }
      const [created] = await db
        .insert(companyEmailSettings)
        .values({
          companyId,
          ...data,
        })
        .returning();
      return created;
    },

    /** Create a new inbox via AgentMail */
    createInbox: async (
      companyId: string,
      options?: { username?: string; display_name?: string },
    ): Promise<AgentMailInbox> => {
      const apiKey = await requireApiKey(companyId);
      const inbox = await agentmailFetch<AgentMailInbox>(
        apiKey,
        "POST",
        "/inboxes",
        options ?? {},
      );

      // Auto-save inbox ID and email to settings
      await db
        .update(companyEmailSettings)
        .set({
          agentmailInboxId: inbox.inbox_id,
          agentmailEmail: inbox.email,
          agentmailDisplayName: inbox.display_name ?? null,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(companyEmailSettings.companyId, companyId));

      log.info({ companyId, inboxId: inbox.inbox_id, email: inbox.email }, "Created AgentMail inbox");
      return inbox;
    },

    /** List inboxes */
    listInboxes: async (companyId: string): Promise<AgentMailInbox[]> => {
      const apiKey = await requireApiKey(companyId);
      const result = await agentmailFetch<{ inboxes: AgentMailInbox[] }>(
        apiKey,
        "GET",
        "/inboxes",
      );
      return result.inboxes ?? [];
    },

    /** List messages in the company inbox */
    listMessages: async (
      companyId: string,
      options?: { limit?: number; page_token?: string },
    ): Promise<{ messages: AgentMailMessage[]; next_page_token?: string }> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) {
        throw new Error("No inbox configured. Create one first.");
      }
      const params = new URLSearchParams();
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.page_token) params.set("page_token", options.page_token);
      const qs = params.toString();
      return agentmailFetch(
        apiKey,
        "GET",
        `/inboxes/${settings.agentmailInboxId}/messages${qs ? `?${qs}` : ""}`,
      );
    },

    /** List threads in the company inbox */
    listThreads: async (
      companyId: string,
      options?: { limit?: number; page_token?: string },
    ): Promise<{ threads: AgentMailThread[]; next_page_token?: string }> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) {
        throw new Error("No inbox configured. Create one first.");
      }
      const params = new URLSearchParams();
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.page_token) params.set("page_token", options.page_token);
      const qs = params.toString();
      return agentmailFetch(
        apiKey,
        "GET",
        `/inboxes/${settings.agentmailInboxId}/threads${qs ? `?${qs}` : ""}`,
      );
    },

    /** Get a specific thread */
    getThread: async (companyId: string, threadId: string): Promise<AgentMailThread> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) throw new Error("No inbox configured.");
      return agentmailFetch(
        apiKey,
        "GET",
        `/inboxes/${settings.agentmailInboxId}/threads/${threadId}`,
      );
    },

    /** Send a message */
    sendMessage: async (
      companyId: string,
      data: { to: string | string[]; subject: string; text?: string; html?: string; cc?: string[]; bcc?: string[] },
    ): Promise<AgentMailSendResult> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) throw new Error("No inbox configured.");
      return agentmailFetch(
        apiKey,
        "POST",
        `/inboxes/${settings.agentmailInboxId}/messages/send`,
        data,
      );
    },

    /** Reply to a message */
    replyToMessage: async (
      companyId: string,
      messageId: string,
      data: { text?: string; html?: string },
    ): Promise<AgentMailSendResult> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) throw new Error("No inbox configured.");
      return agentmailFetch(
        apiKey,
        "POST",
        `/inboxes/${settings.agentmailInboxId}/messages/${messageId}/reply`,
        data,
      );
    },

    /** Delete the company inbox */
    deleteInbox: async (companyId: string): Promise<void> => {
      const apiKey = await requireApiKey(companyId);
      const settings = await getSettings(companyId);
      if (!settings?.agentmailInboxId) throw new Error("No inbox configured.");
      await agentmailFetch(apiKey, "DELETE", `/inboxes/${settings.agentmailInboxId}`);
      await db
        .update(companyEmailSettings)
        .set({
          agentmailInboxId: null,
          agentmailEmail: null,
          enabled: false,
          updatedAt: new Date(),
        })
        .where(eq(companyEmailSettings.companyId, companyId));
    },
  };
}
