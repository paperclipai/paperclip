import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

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

// Dates survive as `Date` in-process but serialize to ISO strings over the
// wire, so the contract validator accepts either form. The string form must be
// a real ISO 8601 datetime (offset or `Z`), which is what `Date.toISOString()`
// and JSON serialization produce — a bare non-datetime string is rejected.
const dateOrIso = z.union([z.date(), z.string().datetime({ offset: true })]);

export const approvalSideEffectSchema = z.object({
  kind: z.string().min(1),
  description: z.string().min(1),
  target: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
});

export const approvalRefundDetailSchema = z.object({
  orderId: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  reason: z.string().nullable(),
  lineItems: z.array(z.string()),
});

export const approvalReplyDetailSchema = z.object({
  recipient: z.string().nullable(),
  subject: z.string().nullable(),
  originalMessage: z.string().nullable(),
  proposedMessage: z.string().nullable(),
});

/** Contract-check for the hydrated `GET /approvals/:id?v=2` envelope. */
export const approvalDetailV2Schema = z.object({
  version: z.literal(2),
  id: z.string(),
  companyId: z.string(),
  type: z.enum(APPROVAL_TYPES),
  status: z.enum(APPROVAL_STATUSES),
  requestedByAgentId: z.string().nullable(),
  requestedByUserId: z.string().nullable(),
  decisionNote: z.string().nullable(),
  decidedByUserId: z.string().nullable(),
  decidedAt: dateOrIso.nullable(),
  createdAt: dateOrIso,
  updatedAt: dateOrIso,
  summary: z.string().min(1),
  sideEffects: z.array(approvalSideEffectSchema),
  refund: approvalRefundDetailSchema.nullable(),
  reply: approvalReplyDetailSchema.nullable(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ApprovalDetailV2Contract = z.infer<typeof approvalDetailV2Schema>;
