export type SkillStatus = "pending_eval" | "published" | "needs_human_review" | "archived";

export interface SkillSynthesisResult {
  skillName: string;
  skillPath: string;
  topicSlug: string;
  synthesisUsedTokens: number;
  chunksProcessed: number;
}

export interface EvalTask {
  task: string;
  score: number;
  attempt: string;
}

export interface EvalResult {
  skillPath: string;
  topicSlug: string;
  averageScore: number;
  tasks: EvalTask[];
  totalTokensUsed: number;
}

export interface SynthesizedSkill {
  id: string;
  topicId: string;
  skillName: string;
  skillPath: string;
  status: SkillStatus;
  evalScore: number | null;
  evalTasks: EvalTask[] | null;
  synthesizedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

export interface SynthesizeRequest {
  topicSlug: string;
}

export interface SynthesizeResponse {
  success: boolean;
  skill?: SynthesizedSkill;
  error?: string;
}

export interface SkillsListResponse {
  skills: SynthesizedSkill[];
}

export interface SkillDetailResponse {
  skill: SynthesizedSkill | null;
  error?: string;
}