import type {
  ChannelCardKind,
  ChannelKind,
  ChannelMemberRole,
  ChannelMessageType,
  ChannelWorkMode,
  PrincipalType,
} from "../constants.js";

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
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  unreadCount?: number;
  muted?: boolean;
}

export interface ChannelMember {
  id: string;
  companyId: string;
  channelId: string;
  principalType: PrincipalType;
  principalId: string;
  role: ChannelMemberRole;
  muted: boolean;
  lastReadAt: Date | null;
  lastReadMessageId: string | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelMessage {
  id: string;
  companyId: string;
  channelId: string;
  authorType: PrincipalType | "system";
  authorId: string | null;
  messageType: ChannelMessageType;
  body: string;
  threadRootId: string | null;
  replyToId: string | null;
  replyCount: number;
  lastReplyAt: Date | null;
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
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
