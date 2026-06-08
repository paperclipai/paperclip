import { z } from "zod";
import {
  DOCUMENT_REVIEW_THREAD_STATUSES,
  DOCUMENT_SUGGESTION_INSERT_POSITIONS,
  DOCUMENT_SUGGESTION_KINDS,
  DOCUMENT_SUGGESTION_STATUSES,
} from "../constants.js";
import { documentAnnotationAnchorSelectorSchema } from "./document-annotation.js";
import { multilineTextSchema } from "./text.js";

export const documentReviewThreadStatusSchema = z.enum(DOCUMENT_REVIEW_THREAD_STATUSES);
export const documentSuggestionKindSchema = z.enum(DOCUMENT_SUGGESTION_KINDS);
export const documentSuggestionInsertPositionSchema = z.enum(DOCUMENT_SUGGESTION_INSERT_POSITIONS);
export const documentSuggestionStatusSchema = z.enum(DOCUMENT_SUGGESTION_STATUSES);

const reviewBodySchema = multilineTextSchema.pipe(z.string().min(1).max(20_000));
const suggestedTextSchema = z.string().max(100_000);

export const createDocumentReviewThreadSchema = z.object({
  body: reviewBodySchema,
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict();

export const createDocumentReviewCommentSchema = z.object({
  body: reviewBodySchema,
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict();

export const updateDocumentReviewThreadSchema = z.object({
  status: documentReviewThreadStatusSchema.optional(),
}).strict().refine((value) => value.status != null, {
  message: "At least one field must be provided",
});

export const createDocumentSuggestionSchema = z.object({
  baseRevisionId: z.string().uuid(),
  baseRevisionNumber: z.number().int().positive(),
  kind: documentSuggestionKindSchema,
  selector: documentAnnotationAnchorSelectorSchema,
  proposedText: suggestedTextSchema.nullable().optional(),
  insertionPosition: documentSuggestionInsertPositionSchema.nullable().optional(),
  body: reviewBodySchema.nullable().optional(),
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  const proposedText = value.proposedText ?? "";
  if ((value.kind === "insertion" || value.kind === "substitution") && proposedText.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "proposedText is required for insertion and substitution suggestions",
      path: ["proposedText"],
    });
  }
  if (value.kind === "deletion" && proposedText.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "deletion suggestions cannot include proposedText",
      path: ["proposedText"],
    });
  }
  if (value.kind !== "insertion" && value.insertionPosition != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "insertionPosition is only valid for insertion suggestions",
      path: ["insertionPosition"],
    });
  }
});

export const createDocumentSuggestionCommentSchema = z.object({
  body: reviewBodySchema,
  issueCommentId: z.string().uuid().nullable().optional(),
}).strict();

export const acceptDocumentSuggestionSchema = z.object({
  baseRevisionId: z.string().uuid(),
  changeSummary: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();

export const rejectDocumentSuggestionSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).nullable().optional(),
}).strict();

export const resolveDocumentSuggestionSchema = z.object({
  note: z.string().trim().min(1).max(2_000).nullable().optional(),
}).strict();

export type CreateDocumentReviewThread = z.infer<typeof createDocumentReviewThreadSchema>;
export type CreateDocumentReviewComment = z.infer<typeof createDocumentReviewCommentSchema>;
export type UpdateDocumentReviewThread = z.infer<typeof updateDocumentReviewThreadSchema>;
export type CreateDocumentSuggestion = z.infer<typeof createDocumentSuggestionSchema>;
export type CreateDocumentSuggestionComment = z.infer<typeof createDocumentSuggestionCommentSchema>;
export type AcceptDocumentSuggestion = z.infer<typeof acceptDocumentSuggestionSchema>;
export type RejectDocumentSuggestion = z.infer<typeof rejectDocumentSuggestionSchema>;
export type ResolveDocumentSuggestion = z.infer<typeof resolveDocumentSuggestionSchema>;
