import { z } from "zod";
import {
  KNOWLEDGE_ITEM_KINDS,
  KNOWLEDGE_NOTE_BODY_MAX_BYTES,
} from "../constants.js";

export const knowledgeItemKindSchema = z.enum(KNOWLEDGE_ITEM_KINDS);

const knowledgeTitleSchema = z.string().trim().min(1).max(200);
const knowledgeSummarySchema = z.string().trim().min(1).max(2000).optional().nullable();
const knowledgeBodySchema = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).length <= KNOWLEDGE_NOTE_BODY_MAX_BYTES,
    `Note body must be at most ${KNOWLEDGE_NOTE_BODY_MAX_BYTES} bytes`,
  );
const knowledgeAssetIdSchema = z.string().uuid();
const knowledgeSourceUrlSchema = z.string().trim().url().max(2048);

export const createKnowledgeItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      title: knowledgeTitleSchema,
      kind: z.literal("note"),
      summary: knowledgeSummarySchema,
      body: knowledgeBodySchema,
    })
    .strict(),
  z
    .object({
      title: knowledgeTitleSchema,
      kind: z.literal("asset"),
      summary: knowledgeSummarySchema,
      assetId: knowledgeAssetIdSchema,
    })
    .strict(),
  z
    .object({
      title: knowledgeTitleSchema,
      kind: z.literal("url"),
      summary: knowledgeSummarySchema,
      sourceUrl: knowledgeSourceUrlSchema,
    })
    .strict(),
]);

export type CreateKnowledgeItem = z.infer<typeof createKnowledgeItemSchema>;

export const updateKnowledgeItemSchema = z
  .object({
    title: knowledgeTitleSchema.optional(),
    summary: knowledgeSummarySchema,
    body: knowledgeBodySchema.optional().nullable(),
    assetId: knowledgeAssetIdSchema.optional().nullable(),
    sourceUrl: knowledgeSourceUrlSchema.optional().nullable(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type UpdateKnowledgeItem = z.infer<typeof updateKnowledgeItemSchema>;

export const attachIssueKnowledgeItemSchema = z
  .object({
    knowledgeItemId: z.string().uuid(),
  })
  .strict();

export type AttachIssueKnowledgeItem = z.infer<typeof attachIssueKnowledgeItemSchema>;
