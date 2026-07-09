import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const approvalGrantInputSchema = z.object({
  permissionKey: z.string().min(1),
  scope: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const requestBoardApprovalPayloadSchema = z.object({
  grants: z.array(approvalGrantInputSchema).min(1).optional(),
  title: z.string().min(1).optional(),
  reason: z.string().optional(),
  expiresInHours: z.number().int().positive().max(168).optional(),
});

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;
export type RequestBoardApprovalPayload = z.infer<typeof requestBoardApprovalPayloadSchema>;
export type ApprovalGrantInput = z.infer<typeof approvalGrantInputSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
