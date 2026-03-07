import type {
  KnowledgeStatus,
  MessageType,
  MessagePriority,
  ProposalType,
  ProposalStatus,
  QuorumType,
  VoteValue,
} from "../constants.js";

// ── Agent Memory ───────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string;
  companyId: string;
  agentId: string;
  key: string;
  value: string | null;
  metadata: Record<string, unknown>;
  vaultRef: string | null;
  ttlSeconds: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Knowledge Base ─────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  companyId: string;
  category: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  status: KnowledgeStatus;
  vaultRef: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  version: string;
  ratifiedByProposalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Agent Messages ─────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  companyId: string;
  channel: string | null;
  fromAgentId: string;
  toAgentId: string | null;
  messageType: MessageType;
  subject: string | null;
  body: string;
  payload: Record<string, unknown> | null;
  parentMessageId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  priority: MessagePriority;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
  createdAt: Date;
}

// ── Consensus ──────────────────────────────────────────────────────────

export interface ConsensusProposal {
  id: string;
  companyId: string;
  title: string;
  description: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  proposerAgentId: string | null;
  proposerUserId: string | null;
  quorumType: QuorumType;
  quorumMinVotes: number;
  payload: Record<string, unknown> | null;
  knowledgeEntryId: string | null;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  vetoedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsensusVote {
  id: string;
  proposalId: string;
  agentId: string | null;
  userId: string | null;
  vote: VoteValue;
  reasoning: string | null;
  createdAt: Date;
}
