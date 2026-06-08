import { z } from "zod";
import {
  DOCUMENT_LINK_TARGET_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
} from "../constants.js";

const stringList = (item: z.ZodTypeAny) =>
  z.union([item, z.array(item)]).optional().transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const documentLinkTargetTypeSchema = z.enum(DOCUMENT_LINK_TARGET_TYPES);

export const companyDocumentListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: stringList(documentStatusSchema),
  type: stringList(documentTypeSchema),
  ownerAgentId: z.string().uuid().optional(),
  ownerUserId: z.string().trim().min(1).max(200).optional(),
  targetType: documentLinkTargetTypeSchema.optional(),
  targetId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  hasOpenFeedback: z.coerce.boolean().optional(),
  trustedOnly: z.coerce.boolean().optional(),
  includeArchived: z.coerce.boolean().optional(),
  updatedAfter: z.coerce.date().optional(),
  updatedBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();

export const updateDocumentMetadataSchema = z.object({
  title: z.string().trim().min(1).max(300).nullable().optional(),
  status: documentStatusSchema.optional(),
  documentType: documentTypeSchema.optional(),
  summary: z.string().trim().max(2_000).nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field must be provided",
});

export const createDocumentLinkSchema = z.object({
  targetType: documentLinkTargetTypeSchema,
  targetId: z.string().uuid(),
  relationship: z.string().trim().min(1).max(80).optional().default("related"),
}).strict();

export type CompanyDocumentListQuery = z.infer<typeof companyDocumentListQuerySchema>;
export type UpdateDocumentMetadata = z.infer<typeof updateDocumentMetadataSchema>;
export type CreateDocumentLink = z.infer<typeof createDocumentLinkSchema>;
