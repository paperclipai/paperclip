import { z } from "zod";
import {
  EXTERNAL_OBJECT_LIVENESS_STATES,
  EXTERNAL_OBJECT_MENTION_CONFIDENCES,
  EXTERNAL_OBJECT_MENTION_SOURCE_KINDS,
  EXTERNAL_OBJECT_STATUS_CATEGORIES,
  EXTERNAL_OBJECT_STATUS_TONES,
} from "../constants.js";

export const externalObjectStatusCategorySchema = z.enum(EXTERNAL_OBJECT_STATUS_CATEGORIES);
export const externalObjectStatusToneSchema = z.enum(EXTERNAL_OBJECT_STATUS_TONES);
export const externalObjectLivenessStateSchema = z.enum(EXTERNAL_OBJECT_LIVENESS_STATES);
export const externalObjectMentionSourceKindSchema = z.enum(EXTERNAL_OBJECT_MENTION_SOURCE_KINDS);
export const externalObjectMentionConfidenceSchema = z.enum(EXTERNAL_OBJECT_MENTION_CONFIDENCES);
export const externalObjectProviderKeySchema = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/);
export const externalObjectTypeSchema = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/);

export const externalObjectCanonicalIdentitySchema = z
  .object({
    scheme: z.enum(["http", "https"]),
    host: z.string().trim().min(1),
    path: z.string().trim().min(1),
    queryParamHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  })
  .strict();

export const externalObjectMentionSourceSchema = z
  .object({
    sourceKind: externalObjectMentionSourceKindSchema,
    documentKey: z.string().trim().min(1).optional().nullable(),
    propertyKey: z.string().trim().min(1).optional().nullable(),
  })
  .strict();

export type ExternalObjectCanonicalIdentityInput = z.infer<typeof externalObjectCanonicalIdentitySchema>;
export type ExternalObjectMentionSourceInput = z.infer<typeof externalObjectMentionSourceSchema>;
export type ExternalObjectProviderKeyInput = z.infer<typeof externalObjectProviderKeySchema>;
export type ExternalObjectTypeInput = z.infer<typeof externalObjectTypeSchema>;
