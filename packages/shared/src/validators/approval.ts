import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

const approvalCommentBodyField = z.string().trim().min(1);

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z
  .object({
    body: approvalCommentBodyField.optional(),
    content: approvalCommentBodyField.optional(),
    comments: approvalCommentBodyField.optional(),
  })
  .transform((input, ctx) => {
    const body = input.body ?? input.content ?? input.comments;
    if (body) {
      return { body };
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected approval comment body in body, content, or comments",
      path: ["body"],
    });
    return z.NEVER;
  });

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
