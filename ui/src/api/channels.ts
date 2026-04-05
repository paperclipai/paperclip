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
  reasoning: string | null;
  createdAt: string;
}

export interface ExpertiseTopic {
  topic: string;
  messageCount: number;
  decisionCount: number;
}

export interface AgentExpertise {
  agentId: string;
  agentName: string;
  topics: ExpertiseTopic[];
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

export interface ChannelSummary {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  actionItems: string[];
  messageCount: number;
}

export interface QuorumResult {
  required: string[];
  responded: string[];
  missing: string[];
  quorumReached: boolean;
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
    body: { body: string; messageType?: string; reasoning?: string; replyToId?: string },
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
  deliberate: (
    companyId: string,
    channelId: string,
    body: { topic: string; invitedAgentIds: string[]; initiatedByAgentId?: string },
  ) =>
    api.post<{ deliberationId: string }>(
      `/companies/${companyId}/channels/${channelId}/deliberate`,
      body,
    ),
  concludeDeliberation: (companyId: string, channelId: string, deliberationId: string) =>
    api.post<{ synthesis: string }>(
      `/companies/${companyId}/channels/${channelId}/deliberations/${deliberationId}/conclude`,
      {},
    ),
  forkAndTest: (
    companyId: string,
    channelId: string,
    body: {
      topic: string;
      approachA: { agentId: string; description: string };
      approachB: { agentId: string; description: string };
      goalId?: string;
      projectId?: string;
    },
  ) =>
    api.post<{ issueAId: string; issueBId: string }>(
      `/companies/${companyId}/channels/${channelId}/fork-and-test`,
      body,
    ),
  expertiseMap: (companyId: string) =>
    api.get<AgentExpertise[]>(`/companies/${companyId}/expertise-map`),
  summary: (companyId: string, channelId: string, days = 7) =>
    api.get<ChannelSummary>(
      `/companies/${companyId}/channels/${channelId}/summary?days=${days}`,
    ),
  createIssueFromMessage: (
    companyId: string,
    channelId: string,
    messageId: string,
    body: { title?: string; assigneeAgentId?: string },
  ) =>
    api.post<{ id: string; title: string; identifier: string }>(
      `/companies/${companyId}/channels/${channelId}/messages/${messageId}/create-issue`,
      body,
    ),
  quorum: (companyId: string, channelId: string, messageId: string) =>
    api.get<QuorumResult>(
      `/companies/${companyId}/channels/${channelId}/messages/${messageId}/quorum`,
    ),
};
