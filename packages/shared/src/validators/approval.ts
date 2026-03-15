import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { learnedSkillProvenanceSchema } from "./skill.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

export const learnedSkillApprovalPayloadSchema = z.object({
  skillId: z.string().uuid(),
  skillName: z.string().trim().min(1).max(200),
  tier: z.enum(["agent", "company"]),
  agentId: z.string().uuid().nullable(),
  summary: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).nullable(),
  sourceRunId: z.string().uuid(),
  sourceChatSessionId: z.string().uuid().nullable(),
  sourceChatMessageId: z.string().uuid().nullable(),
  provenance: learnedSkillProvenanceSchema,
  draftSkillContent: z.string().trim().min(1),
});

export type LearnedSkillApprovalPayload = z.infer<typeof learnedSkillApprovalPayloadSchema>;
