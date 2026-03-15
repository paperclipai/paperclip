import { z } from "zod";

export const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  tier: z.enum(["company", "agent"]),
  agentId: z.string().uuid().optional().nullable(),
  sourceType: z.enum(["bundled", "git", "local"]).optional().default("local"),
  sourceUrl: z.string().optional().nullable(),
  installedPath: z.string().min(1),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateSkill = z.infer<typeof createSkillSchema>;

export const installSkillSchema = z.object({
  command: z.string().min(1),
  tier: z.enum(["company", "agent"]).optional().default("company"),
  agentId: z.string().uuid().optional().nullable(),
  targetDir: z.string().optional().nullable(),
});

export type InstallSkill = z.infer<typeof installSkillSchema>;

export const learnedSkillCandidateStateSchema = z.enum([
  "pending_board",
  "revision_requested",
  "approved",
  "rejected",
]);

export const learnedSkillProvenanceSchema = z.object({
  authoringSkill: z.literal("paperclip-create-skill"),
  authoringMethod: z.string().trim().min(1).max(200).optional().nullable(),
  evidence: z.string().trim().min(1).max(2_000).optional().nullable(),
});

export const learnedSkillCandidateMetadataSchema = z.object({
  state: learnedSkillCandidateStateSchema,
  summary: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).nullable(),
  sourceRunId: z.string().uuid(),
  sourceChatSessionId: z.string().uuid().nullable(),
  sourceChatMessageId: z.string().uuid().nullable(),
  approvalId: z.string().uuid().nullable(),
  provenance: learnedSkillProvenanceSchema,
  draftSkillContent: z.string().trim().min(1),
  requestedAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedByUserId: z.string().trim().min(1).nullable(),
});

export type LearnedSkillCandidateState = z.infer<typeof learnedSkillCandidateStateSchema>;
export type LearnedSkillProvenance = z.infer<typeof learnedSkillProvenanceSchema>;
export type LearnedSkillCandidateMetadata = z.infer<typeof learnedSkillCandidateMetadataSchema>;
