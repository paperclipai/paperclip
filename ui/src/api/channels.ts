import type { Company } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

/**
 * Channels collab layer (doc/plans/2026-07-28-channels-collab-layer.md).
 *
 * Project = channel, task = root message, updates = thread.
 *
 * TODO(channels): the canonical shapes already live in
 * `packages/shared/src/types/channel.ts` and `packages/shared/src/constants.ts`,
 * but are not re-exported from the package index yet. Swap these local mirrors
 * for `@paperclipai/shared` imports once the shared barrel exports them.
 */
export type ChannelKind = "project" | "public" | "private" | "dm" | "group_dm";
export type ChannelMemberRole = "member" | "admin";
export type ChannelMessageType = "user" | "agent" | "system" | "status" | "card";
export type ChannelWorkMode = "ask" | "plan" | "work";
export type ChannelPrincipalType = "user" | "agent";
export type ChannelCardKind =
  | "task"
  | "run"
  | "artifact"
  | "questions"
  | "document"
  | "confirmation"
  | "approval"
  | "suggest_tasks"
  | "note"
  | "stub";

export interface Channel {
  id: string;
  companyId: string;
  kind: ChannelKind;
  name: string;
  slug: string | null;
  topic: string | null;
  projectId: string | null;
  dmFingerprint: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  unreadCount?: number;
  muted?: boolean;
}

export interface ChannelMessage {
  id: string;
  companyId: string;
  channelId: string;
  authorType: ChannelPrincipalType | "system";
  authorId: string | null;
  messageType: ChannelMessageType;
  body: string;
  threadRootId: string | null;
  replyToId: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  workProductId: string | null;
  interactionId: string | null;
  approvalId: string | null;
  documentId: string | null;
  cardKind: ChannelCardKind | null;
  channelWorkMode: ChannelWorkMode | null;
  mentionedAgentIds: string[];
  mentionedUserIds: string[];
  metadata: Record<string, unknown> | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Joined for UI convenience */
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  issueStatus?: string | null;
  authorName?: string | null;
}

export interface ChannelPresenceAgent {
  agentId: string;
  name: string;
  status: string;
  issueId: string | null;
  issueIdentifier: string | null;
  runId: string | null;
  startedAt: string | null;
}

export interface CreateChannelInput {
  kind: "public" | "private";
  name: string;
  topic?: string | null;
  slug?: string;
}

export interface CreateDmChannelInput {
  principalType: ChannelPrincipalType;
  principalId: string;
}

export interface UpdateChannelInput {
  name?: string;
  topic?: string | null;
  archivedAt?: string | null;
}

export interface PostChannelMessageInput {
  body: string;
  threadRootId?: string | null;
  replyToId?: string | null;
  channelWorkMode?: ChannelWorkMode;
  issueId?: string | null;
  cardKind?: ChannelCardKind | null;
  mentionedAgentIds?: string[];
  mentionedUserIds?: string[];
}

export interface CreateIssueFromMessageInput {
  title: string;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  wakeAssignee?: boolean;
  workMode?: "standard" | "ask" | "planning";
}

export interface UpdateChannelMemberInput {
  muted?: boolean;
  role?: ChannelMemberRole;
}

export interface ChannelMessageListFilters {
  cursor?: string;
  limit?: number;
  /** Completed task roots are hidden by default (grill decision). */
  includeCompleted?: boolean;
}

/** A page of root messages, newest activity first. */
export interface ChannelMessagePage {
  messages: ChannelMessage[];
  nextCursor: string | null;
}

/** A root message plus its Slack-style thread replies. */
export interface ChannelThread {
  root: ChannelMessage | null;
  messages: ChannelMessage[];
}

function messageListSearchParams(filters?: ChannelMessageListFilters) {
  const params = new URLSearchParams();
  if (filters?.cursor) params.set("cursor", filters.cursor);
  if (filters?.limit != null) params.set("limit", String(filters.limit));
  if (filters?.includeCompleted) params.set("includeCompleted", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The server routes land in parallel with this UI, so list responses are read
 * leniently: a bare array and an envelope both normalize to the same shape.
 */
function toMessagePage(raw: ChannelMessagePage | ChannelMessage[] | null): ChannelMessagePage {
  if (Array.isArray(raw)) return { messages: raw, nextCursor: null };
  return { messages: raw?.messages ?? [], nextCursor: raw?.nextCursor ?? null };
}

function toThread(raw: ChannelThread | ChannelMessage[] | null): ChannelThread {
  if (Array.isArray(raw)) {
    return { root: raw[0] ?? null, messages: raw.slice(1) };
  }
  return { root: raw?.root ?? null, messages: raw?.messages ?? [] };
}

export const channelsApi = {
  list: (companyId: string, options?: RequestOptions) =>
    api.get<Channel[]>(`/companies/${companyId}/channels`, options),

  create: (companyId: string, data: CreateChannelInput) =>
    api.post<Channel>(`/companies/${companyId}/channels`, data),

  createDm: (companyId: string, data: CreateDmChannelInput) =>
    api.post<Channel>(`/companies/${companyId}/channels/dm`, data),

  get: (channelId: string, options?: RequestOptions) =>
    api.get<Channel>(`/channels/${channelId}`, options),

  update: (channelId: string, data: UpdateChannelInput) =>
    api.patch<Channel>(`/channels/${channelId}`, data),

  /** Root messages only — the channel timeline. */
  listMessages: async (
    channelId: string,
    filters?: ChannelMessageListFilters,
    options?: RequestOptions,
  ): Promise<ChannelMessagePage> => {
    const raw = await api.get<ChannelMessagePage | ChannelMessage[]>(
      `/channels/${channelId}/messages${messageListSearchParams(filters)}`,
      options,
    );
    return toMessagePage(raw);
  },

  listThread: async (
    channelId: string,
    rootId: string,
    options?: RequestOptions,
  ): Promise<ChannelThread> => {
    const raw = await api.get<ChannelThread | ChannelMessage[]>(
      `/channels/${channelId}/messages/${rootId}/thread`,
      options,
    );
    return toThread(raw);
  },

  postMessage: (channelId: string, data: PostChannelMessageInput) =>
    api.post<ChannelMessage>(`/channels/${channelId}/messages`, data),

  markRead: (channelId: string, messageId?: string) =>
    api.post<{ ok: true }>(`/channels/${channelId}/read`, messageId ? { messageId } : {}),

  updateMember: (channelId: string, data: UpdateChannelMemberInput) =>
    api.patch<{ muted: boolean; role: ChannelMemberRole }>(`/channels/${channelId}/members/me`, data),

  presence: async (
    companyId: string,
    options?: RequestOptions,
  ): Promise<ChannelPresenceAgent[]> => {
    const raw = await api.get<ChannelPresenceAgent[] | { agents: ChannelPresenceAgent[] }>(
      `/companies/${companyId}/channels/presence`,
      options,
    );
    return Array.isArray(raw) ? raw : (raw?.agents ?? []);
  },

  createIssueFromMessage: (
    channelId: string,
    messageId: string,
    data: CreateIssueFromMessageInput,
  ) =>
    api.post<ChannelMessage>(`/channels/${channelId}/messages/${messageId}/create-issue`, data),

  /** Opt an existing company into the channels surface. */
  enableChannels: (companyId: string, enabled: boolean = true) =>
    api.patch<Company>(`/companies/${companyId}`, { channelsEnabled: enabled }),
};
