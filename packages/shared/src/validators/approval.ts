import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";
import { executionGrantApprovalDetails } from "../execution-grant-details.js";
import { executionGrantRequestPayloadSchema } from "./issue.js";

function validateGrantApprovalPayload(payload: Record<string, unknown>, ctx: z.RefinementCtx) {
  if (!("executionGrant" in payload)) return;
  const parsed = executionGrantRequestPayloadSchema.safeParse(payload.executionGrant);
  if (!parsed.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "executionGrant"],
      message: "Invalid execution grant request" });
    return;
  }
  if (payload.detailsMarkdown !== executionGrantApprovalDetails(parsed.data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "detailsMarkdown"],
      message: "Execution grant approval details must show the exact request" });
  }
}

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
}).superRefine((value, ctx) => validateGrantApprovalPayload(value.payload, ctx));

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
}).superRefine((value, ctx) => {
  if (value.payload) validateGrantApprovalPayload(value.payload, ctx);
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
