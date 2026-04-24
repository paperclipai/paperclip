import { z } from "zod";

const issueActionQaVerdictStateSchema = z.enum(["pass", "warn", "fail", "na"]);
const issueActionOpenStatusSchema = z.enum(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export const issueActionQaSummarySchema = z.object({
  codeQuality: issueActionQaVerdictStateSchema,
  errorHandling: issueActionQaVerdictStateSchema,
  testCoverage: issueActionQaVerdictStateSchema,
  commentQuality: issueActionQaVerdictStateSchema,
  docsImpact: issueActionQaVerdictStateSchema,
});

export const issueActionQaVerificationSchema = z.object({
  typecheck: issueActionQaVerdictStateSchema,
  tests: issueActionQaVerdictStateSchema,
  build: issueActionQaVerdictStateSchema,
  smoke: issueActionQaVerdictStateSchema,
});

export const issueActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("enter_review"),
    payload: z.object({
      body: z.string().trim().min(1).max(20000).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("submit_qa_verdict"),
    payload: z.object({
      summary: issueActionQaSummarySchema,
      verification: issueActionQaVerificationSchema,
      qaPass: z.boolean(),
      releaseConfirmed: z.boolean(),
      summaryText: z.string().trim().min(1).max(20000).nullable().optional(),
      verificationText: z.string().trim().min(1).max(20000).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("complete_issue"),
    payload: z.object({
      body: z.string().trim().min(1).max(20000).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("reopen_issue"),
    payload: z.object({
      status: issueActionOpenStatusSchema.optional().default("todo"),
      body: z.string().trim().min(1).max(20000).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("handoff_issue"),
    payload: z.object({
      assigneeAgentId: z.string().uuid().nullable().optional(),
      assigneeUserId: z.string().trim().min(1).nullable().optional(),
      body: z.string().trim().min(1).max(20000),
      reopen: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("append_note"),
    payload: z.object({
      body: z.string().trim().min(1).max(20000),
      reopen: z.boolean().optional(),
    }),
  }),
]);

export type IssueActionRequest = z.infer<typeof issueActionSchema>;
