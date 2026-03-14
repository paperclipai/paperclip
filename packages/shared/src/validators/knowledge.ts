import { z } from "zod";

const knowledgeTagSchema = z.string().trim().min(1).max(40).transform((value) => value.toLowerCase());

const knowledgeDocumentBaseSchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().max(80).optional().nullable().transform((value) => value && value.length > 0 ? value : null),
  tags: z.array(knowledgeTagSchema).max(24).optional().default([]),
  content: z.string().trim().min(1).max(20000),
});

export const createKnowledgeDocumentSchema = knowledgeDocumentBaseSchema;
export type CreateKnowledgeDocument = z.infer<typeof createKnowledgeDocumentSchema>;

export const updateKnowledgeDocumentSchema = knowledgeDocumentBaseSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
export type UpdateKnowledgeDocument = z.infer<typeof updateKnowledgeDocumentSchema>;

export const listKnowledgeDocumentsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
export type ListKnowledgeDocumentsQuery = z.infer<typeof listKnowledgeDocumentsQuerySchema>;