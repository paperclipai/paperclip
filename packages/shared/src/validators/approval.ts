import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const SECRET_OPERATION_OPS = ["rename", "delete"] as const;
export type SecretOperationOp = (typeof SECRET_OPERATION_OPS)[number];

// Free-text fields the board card renders. They are the only place a
// `secret_operation` payload may carry human context: every key that matches the
// redactor's secret-name pattern (`secretId`, `secretName`, …) is blanked to
// `***REDACTED***` on read, which would leave the board approving an operation it
// cannot see. `targetId` and `newName` pass the redactor intact.
const secretOperationContextShape = {
  title: z.string().trim().min(1).max(200).optional(),
  summary: multilineTextSchema.optional(),
  recommendedAction: multilineTextSchema.optional(),
  nextActionOnApproval: multilineTextSchema.optional(),
  risks: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
};

// Strict on purpose: an unknown key is rejected rather than stored, so a payload
// can never smuggle a secret *value* (`value`, `material`, …) into an approval row.
export const secretOperationPayloadSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("rename"),
      targetId: z.string().uuid(),
      newName: z.string().trim().min(1).max(200),
      ...secretOperationContextShape,
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      targetId: z.string().uuid(),
      ...secretOperationContextShape,
    })
    .strict(),
]);

export type SecretOperationPayload = z.infer<typeof secretOperationPayloadSchema>;

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
