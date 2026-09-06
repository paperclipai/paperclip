import { z } from "zod";
import {
  PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  PRODUCT_FEEDBACK_MAX_LENGTH,
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
} from "../types/product-feedback.js";

export const productFeedbackCapabilitySchema = z.object({
  enabled: z.boolean(),
  limits: z.object({
    feedbackMaxLength: z.number().int().positive().max(PRODUCT_FEEDBACK_MAX_LENGTH),
    diagnosticCount: z.number().int().nonnegative().max(PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT),
  }).strict(),
}).strict();

const safeTokenSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/i);
const routeTemplateSchema = z.string().min(1).max(240).regex(/^\/[A-Za-z0-9/_:.-]*$/);
const diagnosticSummarySchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9 ._()/-]+$/);
const appVersionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9.+_-]+$/);

export const productFeedbackDiagnosticSchema = z.object({
  code: safeTokenSchema,
  component: safeTokenSchema,
  routeTemplate: routeTemplateSchema,
  timestamp: z.string().datetime(),
}).strict();

export const productFeedbackContextSchema = z.object({
  routeTemplate: routeTemplateSchema,
  appVersion: appVersionSchema.nullable(),
  deploymentMode: z.enum(["local_trusted", "authenticated"]),
  browser: diagnosticSummarySchema,
  operatingSystem: diagnosticSummarySchema,
  diagnostics: z.array(productFeedbackDiagnosticSchema).max(PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT),
}).strict();

const productFeedbackSubmissionBaseSchema = z.object({
  companyId: z.string().uuid(),
  schemaVersion: z.literal(PRODUCT_FEEDBACK_SCHEMA_VERSION),
  submissionId: z.string().uuid(),
  submittedAt: z.string().datetime(),
  feedback: z.string().trim().min(1).max(PRODUCT_FEEDBACK_MAX_LENGTH),
  followUpConsent: z.boolean(),
  reporterEmail: z.string().trim().email().max(320).optional(),
  context: productFeedbackContextSchema,
}).strict();

function validateFollowUpConsent(
  value: { followUpConsent: boolean; reporterEmail?: string },
  ctx: z.RefinementCtx,
) {
  if (value.followUpConsent && value.reporterEmail === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail is required when followUpConsent is enabled",
      path: ["reporterEmail"],
    });
  } else if (!value.followUpConsent && value.reporterEmail !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail requires followUpConsent",
      path: ["reporterEmail"],
    });
  }
}

export const productFeedbackSubmissionRequestSchema = productFeedbackSubmissionBaseSchema
  .superRefine(validateFollowUpConsent);

export const productFeedbackRelayRequestSchema = productFeedbackSubmissionBaseSchema
  .omit({ companyId: true })
  .superRefine(validateFollowUpConsent);

export const productFeedbackReceiptSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  submissionId: z.string().uuid(),
  receiptId: z.string().uuid(),
}).strict();

export const productFeedbackBodySchema = z.string().trim().min(1).max(PRODUCT_FEEDBACK_MAX_LENGTH);

export type ProductFeedbackSubmissionRequestInput = z.infer<typeof productFeedbackSubmissionRequestSchema>;
