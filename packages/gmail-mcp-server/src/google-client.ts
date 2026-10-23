import { google } from "googleapis";
import type { GmailOAuthCredentials } from "./config.js";
import { buildRawMessage, extractMessageBody, getHeader, type GmailHeader } from "./mime.js";

const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-Id"];

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number | null;
  threadsTotal: number | null;
}

export interface ThreadSummary {
  threadId: string;
  snippet: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
}

export interface SearchThreadsResult {
  threads: ThreadSummary[];
  nextPageToken: string | null;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
  body: string;
  bodyTruncated: boolean;
  attachmentFilenames: string[];
}

export interface ThreadDetail {
  threadId: string;
  messages: MessageSummary[];
}

export interface LabelSummary {
  id: string;
  name: string;
  type: string | null;
}

export interface DraftSummary {
  draftId: string;
  message: MessageSummary;
}

export interface ListDraftsResult {
  drafts: DraftSummary[];
  nextPageToken: string | null;
}

export interface CreateDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  replyToMessageId?: string | null;
}

export interface GmailClient {
  getProfile(): Promise<GmailProfile>;
  searchThreads(input: { query: string; maxResults: number; pageToken?: string | null }): Promise<SearchThreadsResult>;
  getThread(threadId: string): Promise<ThreadDetail>;
  getMessage(messageId: string): Promise<MessageSummary>;
  listLabels(): Promise<LabelSummary[]>;
  listDrafts(input: { maxResults: number; pageToken?: string | null }): Promise<ListDraftsResult>;
  getDraft(draftId: string): Promise<DraftSummary>;
  createDraft(input: CreateDraftInput): Promise<DraftSummary>;
}

type GmailApi = ReturnType<typeof google.gmail>;

function summarizeMessage(raw: unknown): MessageSummary {
  const message = raw as {
    id?: string;
    threadId?: string;
    snippet?: string;
    payload?: Parameters<typeof extractMessageBody>[0];
  };
  const headers = (message.payload as { headers?: GmailHeader[] } | undefined)?.headers ?? null;
  const { text, truncated, attachmentFilenames } = extractMessageBody(message.payload ?? null);
  return {
    id: String(message.id ?? ""),
    threadId: String(message.threadId ?? ""),
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: typeof message.snippet === "string" ? message.snippet : "",
    body: text,
    bodyTruncated: truncated,
    attachmentFilenames,
  };
}

export function createGmailClient(credentials: GmailOAuthCredentials): GmailClient {
  const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  auth.setCredentials({ refresh_token: credentials.refreshToken });
  const gmail: GmailApi = google.gmail({ version: "v1", auth });

  return {
    async getProfile() {
      const response = await gmail.users.getProfile({ userId: "me" });
      return {
        emailAddress: String(response.data.emailAddress ?? ""),
        messagesTotal: response.data.messagesTotal ?? null,
        threadsTotal: response.data.threadsTotal ?? null,
      };
    },

    async searchThreads({ query, maxResults, pageToken }) {
      const list = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults,
        pageToken: pageToken ?? undefined,
      });
      const summaries = await Promise.all(
        (list.data.threads ?? []).map(async (thread) => {
          const detail = await gmail.users.threads.get({
            userId: "me",
            id: thread.id ?? undefined,
            format: "metadata",
            metadataHeaders: METADATA_HEADERS,
          });
          const firstMessage = detail.data.messages?.[0];
          const headers = (firstMessage?.payload as { headers?: GmailHeader[] } | undefined)?.headers ?? null;
          return {
            threadId: String(thread.id ?? ""),
            snippet: typeof thread.snippet === "string" ? thread.snippet : "",
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            subject: getHeader(headers, "Subject"),
            date: getHeader(headers, "Date"),
          } satisfies ThreadSummary;
        }),
      );
      return {
        threads: summaries,
        nextPageToken: list.data.nextPageToken ?? null,
      };
    },

    async getThread(threadId) {
      const response = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      return {
        threadId,
        messages: (response.data.messages ?? []).map(summarizeMessage),
      };
    },

    async getMessage(messageId) {
      const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      return summarizeMessage(response.data);
    },

    async listLabels() {
      const response = await gmail.users.labels.list({ userId: "me" });
      return (response.data.labels ?? []).map((label) => ({
        id: String(label.id ?? ""),
        name: String(label.name ?? ""),
        type: label.type ?? null,
      }));
    },

    async listDrafts({ maxResults, pageToken }) {
      const list = await gmail.users.drafts.list({
        userId: "me",
        maxResults,
        pageToken: pageToken ?? undefined,
      });
      const drafts = await Promise.all(
        (list.data.drafts ?? []).map(async (draft) => {
          const detail = await gmail.users.drafts.get({ userId: "me", id: draft.id ?? undefined, format: "full" });
          return {
            draftId: String(draft.id ?? ""),
            message: summarizeMessage(detail.data.message),
          } satisfies DraftSummary;
        }),
      );
      return { drafts, nextPageToken: list.data.nextPageToken ?? null };
    },

    async getDraft(draftId) {
      const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
      return {
        draftId,
        message: summarizeMessage(response.data.message),
      };
    },

    async createDraft({ to, cc, bcc, subject, body, replyToMessageId }) {
      let inReplyToMessageId: string | null = null;
      let references: string | null = null;
      let threadId: string | undefined;

      if (replyToMessageId) {
        const original = await gmail.users.messages.get({
          userId: "me",
          id: replyToMessageId,
          format: "metadata",
          metadataHeaders: ["Message-Id", "References"],
        });
        const headers = (original.data.payload as { headers?: GmailHeader[] } | undefined)?.headers ?? null;
        inReplyToMessageId = getHeader(headers, "Message-Id");
        const priorReferences = getHeader(headers, "References");
        references = [priorReferences, inReplyToMessageId].filter(Boolean).join(" ") || null;
        threadId = original.data.threadId ?? undefined;
      }

      const raw = buildRawMessage({
        to,
        cc,
        bcc,
        subject,
        body,
        inReplyToMessageId,
        references,
      });

      const response = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw, threadId },
        },
      });

      return {
        draftId: String(response.data.id ?? ""),
        message: summarizeMessage(response.data.message),
      };
    },
  };
}
