import { z } from "zod";

export const formalQaPreparationStatusSchema = z.literal("prepared");

/** A board request names a target only; GitHub and the server policy supply the authority. */
export const createFormalQaPreparationSchema = z.object({
  projectId: z.string().uuid(),
  projectWorkspaceId: z.string().uuid(),
  prNumber: z.number().int().positive().max(2_147_483_647),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

export type CreateFormalQaPreparation = z.infer<typeof createFormalQaPreparationSchema>;

export const upsertFormalQaPolicySchema = z.object({
  projectWorkspaceId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  requiredWorkflowId: z.union([z.string().trim().min(1).max(40), z.number().int().positive()]).transform(String),
  requiredCheckName: z.string().trim().min(1).max(255),
  requiredCheckAppId: z.number().int().positive(),
  enabled: z.boolean(),
}).strict();

export type UpsertFormalQaPolicy = z.infer<typeof upsertFormalQaPolicySchema>;
