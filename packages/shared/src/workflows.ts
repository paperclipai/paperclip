import { z } from "zod";
import { caseWorkflowDocumentTextSchema } from "./case-handoffs.js";

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: caseWorkflowDocumentTextSchema,
}).strict();
export const updateWorkflowSchema = createWorkflowSchema.partial().refine(
  value => value.name !== undefined || value.prompt !== undefined, "Provide name or prompt",
);
export const listWorkflowsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export const readWorkflowQuerySchema = z.object({
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
