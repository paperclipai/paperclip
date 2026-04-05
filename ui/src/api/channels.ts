import { api } from "./client";

export interface Channel {
  id: string;
  companyId: string;
  scopeType: "company" | "department" | "project";
  scopeId: string | null;
  name: string;
  pinnedMessageIds: string[];
  createdAt: string;
  unreadCount?: number;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  messageType: string;
  mentions: Array<{ type: string; id: string }>;
  linkedIssueId: string | null;
  replyToId: string | null;
  createdAt: string;
}

export interface DecisionRecord {
  messageId: string;
  decisionText: string;
  decidedByAgentId: string | null;
  decidedByUserId: string | null;
  linkedIssueId: string | null;
  createdAt: string;
}

export interface ChannelAnalytics {
  totalMessages: number;
  messagesByType: Record<string, number>;
  topContributors: Array<{ agentId: string; name: string; messageCount: number }>;
  decisionsCount: number;
  escalationsCount: number;
  avgMessagesPerDay: number;
}

export const channelsApi = {
  list: (companyId: string) =>
    api.get<Channel[]>(`/companies/${companyId}/channels`),
  messages: (companyId: string, channelId: string, limit = 50) =>
    api.get<ChannelMessage[]>(
      `/companies/${companyId}/channels/${channelId}/messages?limit=${limit}`,
    ),
  postMessage: (
    companyId: string,
    channelId: string,
    body: { body: string; messageType?: string },
  ) =>
    api.post<ChannelMessage>(
      `/companies/${companyId}/channels/${channelId}/messages`,
      body,
    ),
  decisions: (companyId: string, channelId: string) =>
    api.get<DecisionRecord[]>(
      `/companies/${companyId}/channels/${channelId}/decisions`,
    ),
  pinned: (companyId: string, channelId: string) =>
    api.get<ChannelMessage[]>(
      `/companies/${companyId}/channels/${channelId}/pinned`,
    ),
  pinMessage: (companyId: string, channelId: string, messageId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/channels/${channelId}/messages/${messageId}/pin`,
      {},
    ),
  unpinMessage: (companyId: string, channelId: string, messageId: string) =>
    api.delete<{ ok: boolean }>(
      `/companies/${companyId}/channels/${channelId}/messages/${messageId}/pin`,
    ),
  analytics: (companyId: string, channelId: string, periodDays = 30) =>
    api.get<ChannelAnalytics>(
      `/companies/${companyId}/channels/${channelId}/analytics?periodDays=${periodDays}`,
    ),
};
