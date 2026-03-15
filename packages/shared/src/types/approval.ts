import type { ApprovalStatus, ApprovalType } from "../constants.js";
import type { LearnedSkillProvenance } from "./skill.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearnedSkillApprovalPayload {
  skillId: string;
  skillName: string;
  tier: "agent" | "company";
  agentId: string | null;
  summary: string;
  confidence: number | null;
  sourceRunId: string;
  sourceChatSessionId: string | null;
  sourceChatMessageId: string | null;
  provenance: LearnedSkillProvenance;
  draftSkillContent: string;
}
