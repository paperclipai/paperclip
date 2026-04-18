import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

const trimmedStringSchema = z.string().trim().min(1);
const confidenceSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.enum(["low", "medium", "high"]),
);
const nextStepModeSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.enum(["execute", "probe", "escalate"]),
);

export const strategistDecisionCardPayloadSchema = z
  .object({
    title: trimmedStringSchema.optional(),
    recommendation: trimmedStringSchema,
    why: z.array(trimmedStringSchema).min(1).max(3),
    topRisk: trimmedStringSchema,
    confidence: confidenceSchema,
    nextStepMode: nextStepModeSchema,
    nextStep: trimmedStringSchema,
    alternatives: z.array(trimmedStringSchema).max(2).optional(),
    evidence: z.array(trimmedStringSchema).optional(),
    changeMyMind: trimmedStringSchema.optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if ((payload.confidence === "low" || payload.confidence === "medium") && !payload.changeMyMind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changeMyMind"],
        message: "changeMyMind is required when confidence is low or medium",
      });
    }
  });

export const createApprovalSchema = z
  .object({
    type: z.enum(APPROVAL_TYPES),
    requestedByAgentId: z.string().uuid().optional().nullable(),
    payload: z.union([strategistDecisionCardPayloadSchema, z.record(z.unknown())]),
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

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
