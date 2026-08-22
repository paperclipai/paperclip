import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";
import { z } from "zod";

const commandProbeSchema = z.object({
  kind: z.literal("command"),
  command: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
  expectedExitCode: z.number().int().min(0).max(255),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

const apiProbeSchema = z.object({
  kind: z.literal("api"),
  url: z.string().url().refine((url) => new URL(url).protocol === "https:", "API probes must use HTTPS"),
  expectedStatus: z.number().int().min(100).max(599),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

const machineRecheckPredicateSchema = z.object({
  kind: z.literal("machine"),
  probe: z.discriminatedUnion("kind", [commandProbeSchema, apiProbeSchema]),
}).strict();

const humanJudgementDeclarationSchema = z.object({
  kind: z.literal("human_judgement"),
  declaration: z.string().trim().min(1).max(4_000),
  humanTrigger: z.string().trim().min(1).max(255),
}).strict();

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
}).superRefine((value, ctx) => {
  if (value.type !== "request_board_approval") return;

  const machine = machineRecheckPredicateSchema.safeParse(value.payload.recheckPredicate);
  const human = humanJudgementDeclarationSchema.safeParse(value.payload.humanJudgement);
  if (machine.success !== human.success) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["payload"],
    message: "request_board_approval requires exactly one of recheckPredicate (machine condition) or humanJudgement (declaration plus named humanTrigger)",
  });
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
