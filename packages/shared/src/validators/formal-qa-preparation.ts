import { z } from "zod";

const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/, "Expected a lowercase 40-character Git object ID");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");

export const formalQaPreparationStatusSchema = z.literal("prepared");

export const createFormalQaPreparationSchema = z.object({
  projectId: z.string().uuid(),
  projectWorkspaceId: z.string().uuid(),
  repository: z.string().trim().regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "Expected canonical owner/repository form",
  ).max(200),
  prNumber: z.number().int().positive().max(2_147_483_647),
  headSha: sha1Schema,
  baseRef: z.string().trim().min(1).max(255),
  baseSha: sha1Schema,
  treeSha: sha1Schema,
  evidenceSha256: sha256Schema,
  issuerReceiptSha256: sha256Schema,
  issuerOperationId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200),
  expiresAt: z.coerce.date().refine((value) => value.getTime() > Date.now(), "Must expire in the future"),
}).strict();

export type CreateFormalQaPreparation = z.infer<typeof createFormalQaPreparationSchema>;
