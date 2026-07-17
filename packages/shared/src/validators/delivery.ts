import { z } from "zod";
import {
  DELIVERY_EVENT_STATES,
  DELIVERY_STAGES,
  EXTERNAL_OPERATION_KINDS,
} from "../types/delivery.js";

export const deliveryStageSchema = z.enum(DELIVERY_STAGES);
export const deliveryEventStateSchema = z.enum(DELIVERY_EVENT_STATES);

const httpUrlSchema = z.string().url().max(4096).refine((value) => {
  const protocol = new URL(value).protocol.toLowerCase();
  return protocol === "https:" || protocol === "http:";
}, "URL must use http or https");

const candidateShaSchema = z.string()
  .trim()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/, "Candidate SHA must be a full 40- or 64-character hexadecimal digest")
  .transform((value) => value.toLowerCase());

const deliveryMetadataSchema = z.record(z.unknown()).superRefine((value, context) => {
  for (const reservedKey of ["paperclipFactory", "paperclipController"]) {
    if (Object.prototype.hasOwnProperty.call(value, reservedKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [reservedKey],
        message: `${reservedKey} is server-owned metadata`,
      });
    }
  }
});

/**
 * Deliberately excludes source and authority. The server derives those fields
 * from the authenticated actor; clients cannot submit provider-verified facts.
 */
export const createDeliveryEventSchema = z.object({
  stage: deliveryStageSchema,
  state: deliveryEventStateSchema,
  candidateSha: candidateShaSchema.optional().nullable(),
  environment: z.string().trim().min(1).max(255).optional().nullable(),
  provider: z.string().trim().min(1).max(255).optional().nullable(),
  providerExternalId: z.string().trim().min(1).max(1024).optional().nullable(),
  providerUrl: httpUrlSchema.optional().nullable(),
  summary: z.string().trim().min(1).max(12_000).optional().nullable(),
  metadata: deliveryMetadataSchema.optional().nullable(),
  supersedesEventId: z.string().uuid().optional().nullable(),
}).strict();

export type CreateDeliveryEvent = z.infer<typeof createDeliveryEventSchema>;

export const createExternalOperationSchema = z.object({
  kind: z.enum(EXTERNAL_OPERATION_KINDS),
  provider: z.string().trim().min(1).max(255),
  stage: deliveryStageSchema,
  externalId: z.string().trim().min(1).max(1024),
  candidateSha: candidateShaSchema.optional().nullable(),
  environment: z.string().trim().min(1).max(255).optional().nullable(),
  url: httpUrlSchema.optional().nullable(),
  credentialSecretId: z.string().uuid().optional().nullable(),
  nextCheckAt: z.coerce.date().optional().nullable(),
  timeoutAt: z.coerce.date().optional().nullable(),
  metadata: deliveryMetadataSchema.optional().nullable(),
}).strict().superRefine((value, context) => {
  if (value.kind === "github_actions_workflow_run" && value.provider !== "github") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"], message: "GitHub Actions operations require provider=github" });
  }
  if (value.kind === "cloudflare_pages_deployment" && value.provider !== "cloudflare") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"], message: "Cloudflare Pages operations require provider=cloudflare" });
  }
});

export type CreateExternalOperation = z.infer<typeof createExternalOperationSchema>;

export const updateExternalOperationSchema = z.object({
  externalId: z.string().trim().min(1).max(1024).optional(),
  candidateSha: candidateShaSchema.optional().nullable(),
  environment: z.string().trim().min(1).max(255).optional().nullable(),
  url: httpUrlSchema.optional().nullable(),
  credentialSecretId: z.string().uuid().optional().nullable(),
  nextCheckAt: z.coerce.date().optional().nullable(),
  timeoutAt: z.coerce.date().optional().nullable(),
  metadata: deliveryMetadataSchema.optional().nullable(),
}).strict();

export type UpdateExternalOperation = z.infer<typeof updateExternalOperationSchema>;

export const legacyDeliveryBackfillSchema = z.object({
  workProductIds: z.array(z.string().uuid()).max(500).optional(),
}).strict().default({});

export type LegacyDeliveryBackfill = z.infer<typeof legacyDeliveryBackfillSchema>;

export const createDeliveryControlUpdateSchema = z.object({
  snapshotRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  note: z.string().trim().min(1).max(4_000).optional().nullable(),
}).strict();

export type CreateDeliveryControlUpdate = z.infer<typeof createDeliveryControlUpdateSchema>;
