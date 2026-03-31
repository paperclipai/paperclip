import { z } from "zod";

export const knowledgeTierSchema = z.enum(["global", "team", "role"]);

const baseCreateCompanyKnowledgeSchema = z.object({
  tier: knowledgeTierSchema,
  targetId: z.string().nullable().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  alwaysInject: z.boolean().default(false),
});

export const createCompanyKnowledgeSchema = baseCreateCompanyKnowledgeSchema.refine(
  (data) => data.tier === "global" || !!data.targetId,
  { message: "targetId is required for team and role tiers", path: ["targetId"] },
);

export const updateCompanyKnowledgeSchema = baseCreateCompanyKnowledgeSchema.partial();

export type CreateCompanyKnowledge = z.infer<typeof createCompanyKnowledgeSchema>;
export type UpdateCompanyKnowledge = z.infer<typeof updateCompanyKnowledgeSchema>;
export type KnowledgeTier = z.infer<typeof knowledgeTierSchema>;
