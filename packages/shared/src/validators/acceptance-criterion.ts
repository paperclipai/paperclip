import { z } from "zod";
import { ISSUE_ACCEPTANCE_CRITERION_STATES } from "../constants.js";

export const issueAcceptanceCriterionStateSchema = z.enum(ISSUE_ACCEPTANCE_CRITERION_STATES);

export const ISSUE_ACCEPTANCE_CRITERION_TEXT_MAX = 500;
export const ISSUE_ACCEPTANCE_CRITERION_NOTES_MAX = 4000;
export const ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE = 50;

export const createIssueAcceptanceCriterionSchema = z
  .object({
    text: z.string().trim().min(1).max(ISSUE_ACCEPTANCE_CRITERION_TEXT_MAX),
    notes: z.string().trim().max(ISSUE_ACCEPTANCE_CRITERION_NOTES_MAX).nullable().optional(),
    position: z.number().int().nonnegative().optional(),
    state: issueAcceptanceCriterionStateSchema.optional(),
    evidenceWorkProductId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CreateIssueAcceptanceCriterion = z.infer<typeof createIssueAcceptanceCriterionSchema>;

export const updateIssueAcceptanceCriterionSchema = z
  .object({
    text: z.string().trim().min(1).max(ISSUE_ACCEPTANCE_CRITERION_TEXT_MAX).optional(),
    notes: z.string().trim().max(ISSUE_ACCEPTANCE_CRITERION_NOTES_MAX).nullable().optional(),
    position: z.number().int().nonnegative().optional(),
    state: issueAcceptanceCriterionStateSchema.optional(),
    evidenceWorkProductId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateIssueAcceptanceCriterion = z.infer<typeof updateIssueAcceptanceCriterionSchema>;

export const setIssueAcceptanceCriterionStateSchema = z
  .object({
    state: issueAcceptanceCriterionStateSchema,
    evidenceWorkProductId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(ISSUE_ACCEPTANCE_CRITERION_NOTES_MAX).nullable().optional(),
  })
  .strict();

export type SetIssueAcceptanceCriterionState = z.infer<typeof setIssueAcceptanceCriterionStateSchema>;
