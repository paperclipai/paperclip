import { z } from "zod";
import {
  IMPROVEMENT_EVIDENCE_KINDS,
  IMPROVEMENT_TARGET_LAYERS,
} from "../types/improvement-suggestion.js";

export const improvementSuggestionEvidenceSchema = z.object({
  kind: z.enum(IMPROVEMENT_EVIDENCE_KINDS),
  ref: z.string().trim().min(1).max(1_000),
  note: z.string().trim().min(1).max(4_000).optional().nullable(),
});

export const createImprovementSuggestionSchema = z.object({
  targetLayer: z.enum(IMPROVEMENT_TARGET_LAYERS),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(8_000),
  proposedChange: z.string().trim().min(1).max(16_000),
  evidence: z.array(improvementSuggestionEvidenceSchema).min(1).max(25),
  sourceIssueId: z.string().uuid().optional().nullable(),
});

export const reviewImprovementSuggestionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().min(1).max(8_000),
});

export const createImprovementImplementationIssueSchema = z.object({
  assigneeAgentId: z.string().uuid().optional().nullable(),
});

export type CreateImprovementSuggestion = z.infer<typeof createImprovementSuggestionSchema>;
export type ReviewImprovementSuggestion = z.infer<typeof reviewImprovementSuggestionSchema>;
export type CreateImprovementImplementationIssue = z.infer<typeof createImprovementImplementationIssueSchema>;
