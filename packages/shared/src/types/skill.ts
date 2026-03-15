export type SkillTier = "built_in" | "company" | "agent";
export type SkillSourceType = "bundled" | "git" | "local";
export type LearnedSkillCandidateState =
  | "pending_board"
  | "revision_requested"
  | "approved"
  | "rejected";

export interface LearnedSkillProvenance {
  authoringSkill: "paperclip-create-skill";
  authoringMethod?: string | null;
  evidence?: string | null;
}

export interface LearnedSkillCandidateMetadata {
  state: LearnedSkillCandidateState;
  summary: string;
  confidence: number | null;
  sourceRunId: string;
  sourceChatSessionId: string | null;
  sourceChatMessageId: string | null;
  approvalId: string | null;
  provenance: LearnedSkillProvenance;
  draftSkillContent: string;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
}

export interface Skill {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  tier: SkillTier;
  defaultEnabled: boolean;
  agentId: string | null;
  sourceType: SkillSourceType;
  sourceUrl: string | null;
  installedPath: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillAssignment {
  agentId: string;
  skillId: string;
  companyId: string;
  createdAt: string;
}

export interface ResolvedSkill {
  name: string;
  tier: SkillTier;
  path: string;
}
