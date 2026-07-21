import { z } from "zod";
import {
  DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES,
  DOCUMENT_ANNOTATION_ANCHOR_STATES,
  DOCUMENT_ANNOTATION_THREAD_STATUSES,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const documentAnnotationThreadStatusSchema = z.enum(DOCUMENT_ANNOTATION_THREAD_STATUSES);
export const documentAnnotationAnchorStateSchema = z.enum(DOCUMENT_ANNOTATION_ANCHOR_STATES);
export const documentAnnotationAnchorConfidenceSchema = z.enum(DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES);

export const documentAnnotationTextQuoteSelectorSchema = z.object({
  exact: z.string().min(1).max(10_000),
  prefix: z.string().max(1_000).default(""),
  suffix: z.string().max(1_000).default(""),
}).strict();

export const documentAnnotationTextPositionSelectorSchema = z.object({
  normalizedStart: z.number().int().nonnegative(),
  normalizedEnd: z.number().int().nonnegative(),
  markdownStart: z.number().int().nonnegative(),
  markdownEnd: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.normalizedEnd <= value.normalizedStart) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "normalizedEnd must be greater than normalizedStart",
      path: ["normalizedEnd"],
    });
  }
  if (value.markdownEnd <= value.markdownStart) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "markdownEnd must be greater than markdownStart",
      path: ["markdownEnd"],
    });
  }
});

export const documentAnnotationAnchorSelectorSchema = z.object({
  quote: documentAnnotationTextQuoteSelectorSchema,
  position: documentAnnotationTextPositionSelectorSchema,
}).strict();

export const createDocumentAnnotationThreadSchema = z.object({
  baseRevisionId: z.string().uuid(),
  baseRevisionNumber: z.number().int().positive(),
  selector: documentAnnotationAnchorSelectorSchema,
  body: multilineTextSchema.pipe(z.string().min(1).max(20_000)),
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict();

export const createDocumentAnnotationCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1).max(20_000)),
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict();

export const updateDocumentAnnotationThreadSchema = z.object({
  status: documentAnnotationThreadStatusSchema.optional(),
}).strict().refine((value) => value.status != null, {
  message: "At least one field must be provided",
});

export type CreateDocumentAnnotationThread = z.infer<typeof createDocumentAnnotationThreadSchema>;
export type CreateDocumentAnnotationComment = z.infer<typeof createDocumentAnnotationCommentSchema>;
export type UpdateDocumentAnnotationThread = z.infer<typeof updateDocumentAnnotationThreadSchema>;
