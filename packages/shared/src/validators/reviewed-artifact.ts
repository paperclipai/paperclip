import { z } from "zod";
import {
  REVIEWED_ARTIFACT_CONTEXT_TYPES,
  REVIEWED_ARTIFACT_DISPLAY_HINTS,
  REVIEWED_ARTIFACT_SELECTION_MODES,
  REVIEWED_ARTIFACT_SOURCE_TYPES,
} from "../constants.js";
import { issueDocumentKeySchema } from "./issue.js";

export const reviewedArtifactContextTypeSchema = z.enum(REVIEWED_ARTIFACT_CONTEXT_TYPES);
export const reviewedArtifactSelectionModeSchema = z.enum(REVIEWED_ARTIFACT_SELECTION_MODES);
export const reviewedArtifactSourceTypeSchema = z.enum(REVIEWED_ARTIFACT_SOURCE_TYPES);
export const reviewedArtifactDisplayHintSchema = z.enum(REVIEWED_ARTIFACT_DISPLAY_HINTS);

export const reviewedArtifactContextSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("issue_review"),
    issueId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("approval"),
    approvalId: z.string().uuid(),
    issueId: z.string().uuid().optional().nullable(),
  }),
]);

const jsonPointerSchema = z.string().min(1).max(500).regex(/^($|\/)/, "Approval payload pointers must be JSON Pointers");

const workspaceRelativePathSchema = z.string().min(1).max(2048).superRefine((value, ctx) => {
  if (value.startsWith("/") || value.includes("\0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace paths must be relative" });
  }
  if (value.split("/").some((segment) => segment === "..")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace paths cannot traverse parents" });
  }
});

const issueDocumentSourceSchema = z.object({
  type: z.literal("issue_document"),
  issueId: z.string().uuid(),
  documentKey: issueDocumentKeySchema,
  revisionId: z.string().uuid().optional().nullable(),
});

const issueAttachmentSourceSchema = z.object({
  type: z.literal("issue_attachment"),
  issueId: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

const issueWorkProductSourceSchema = z.object({
  type: z.literal("issue_work_product"),
  issueId: z.string().uuid(),
  workProductId: z.string().uuid(),
});

const externalUrlSourceSchema = z.object({
  type: z.literal("external_url"),
  url: z.string().url().refine((value) => new URL(value).protocol === "https:", "External URLs must use HTTPS"),
});

const approvalPayloadSourceSchema = z.object({
  type: z.literal("approval_payload"),
  pointer: jsonPointerSchema,
});

const workspaceFileSourceSchema = z.object({
  type: z.literal("workspace_file"),
  issueId: z.string().uuid(),
  executionWorkspaceId: z.string().uuid(),
  runId: z.string().uuid().optional().nullable(),
  path: workspaceRelativePathSchema,
});

export const reviewedArtifactSourceSchema = z.discriminatedUnion("type", [
  issueDocumentSourceSchema,
  issueAttachmentSourceSchema,
  issueWorkProductSourceSchema,
  externalUrlSourceSchema,
  approvalPayloadSourceSchema,
  workspaceFileSourceSchema,
]);

export const writableReviewedArtifactSourceSchema = z.discriminatedUnion("type", [
  issueDocumentSourceSchema,
  issueAttachmentSourceSchema,
  issueWorkProductSourceSchema,
  externalUrlSourceSchema,
  approvalPayloadSourceSchema,
]);

export const createReviewedArtifactItemSchema = z.object({
  source: writableReviewedArtifactSourceSchema,
  title: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  displayHint: reviewedArtifactDisplayHintSchema.optional().nullable(),
  isPrimary: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  selectedExplicitly: z.boolean().optional().default(true),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const createReviewedArtifactSetSchema = z.object({
  companyId: z.string().uuid(),
  context: reviewedArtifactContextSchema,
  selectionMode: reviewedArtifactSelectionModeSchema.optional().default("explicit"),
  title: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  createdByAgentId: z.string().uuid().optional().nullable(),
  createdByUserId: z.string().optional().nullable(),
  createdByRunId: z.string().uuid().optional().nullable(),
  items: z.array(createReviewedArtifactItemSchema).default([]),
});

export type CreateReviewedArtifactItem = z.infer<typeof createReviewedArtifactItemSchema>;
export type CreateReviewedArtifactSet = z.infer<typeof createReviewedArtifactSetSchema>;
