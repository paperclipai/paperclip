import type { AgentThreadMessageRole, AgentThreadStatus } from "../constants.js";

export interface AgentThread {
  id: string;
  companyId: string;
  agentId: string;
  status: AgentThreadStatus;
  archivedAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentThreadMessage {
  id: string;
  threadId: string;
  companyId: string;
  role: AgentThreadMessageRole;
  authorUserId: string | null;
  authorAgentId: string | null;
  producingHeartbeatRunId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentThreadReadState {
  id: string;
  threadId: string;
  companyId: string;
  userId: string;
  lastReadMessageId: string | null;
  lastReadAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
