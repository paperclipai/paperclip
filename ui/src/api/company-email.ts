import { api } from "./client";

export interface EmailSettings {
  id?: string;
  companyId?: string;
  agentmailApiKey?: string;
  agentmailInboxId?: string | null;
  agentmailEmail?: string | null;
  agentmailDisplayName?: string | null;
  enabled: boolean;
}

export interface EmailInbox {
  inbox_id: string;
  email: string;
  display_name?: string;
  created_at: string;
  updated_at: string;
}

export interface EmailMessage {
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

export interface EmailThread {
  thread_id: string;
  subject: string;
  messages: EmailMessage[];
  message_count: number;
  created_at: string;
  updated_at: string;
}

export const companyEmailApi = {
  getSettings: (companyId: string) =>
    api.get<EmailSettings>(`/companies/${companyId}/email/settings`),

  saveSettings: (companyId: string, data: Partial<EmailSettings>) =>
    api.patch<EmailSettings>(`/companies/${companyId}/email/settings`, data),

  createInbox: (companyId: string, data?: { username?: string; display_name?: string }) =>
    api.post<EmailInbox>(`/companies/${companyId}/email/inbox`, data ?? {}),

  listInboxes: (companyId: string) =>
    api.get<EmailInbox[]>(`/companies/${companyId}/email/inboxes`),

  listMessages: (companyId: string, limit?: number, pageToken?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (pageToken) params.set("page_token", pageToken);
    const qs = params.toString();
    return api.get<{ messages: EmailMessage[]; next_page_token?: string }>(
      `/companies/${companyId}/email/messages${qs ? `?${qs}` : ""}`,
    );
  },

  listThreads: (companyId: string, limit?: number, pageToken?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (pageToken) params.set("page_token", pageToken);
    const qs = params.toString();
    return api.get<{ threads: EmailThread[]; next_page_token?: string }>(
      `/companies/${companyId}/email/threads${qs ? `?${qs}` : ""}`,
    );
  },

  getThread: (companyId: string, threadId: string) =>
    api.get<EmailThread>(`/companies/${companyId}/email/threads/${threadId}`),

  sendMessage: (companyId: string, data: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    cc?: string[];
    bcc?: string[];
  }) => api.post<{ message_id: string; thread_id: string }>(
    `/companies/${companyId}/email/send`,
    data,
  ),

  replyToMessage: (companyId: string, messageId: string, data: { text?: string; html?: string }) =>
    api.post<{ message_id: string; thread_id: string }>(
      `/companies/${companyId}/email/messages/${messageId}/reply`,
      data,
    ),
};
