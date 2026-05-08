import { z } from "zod";
import {
  ISSUE_EXECUTION_DECISION_OUTCOMES,
  ISSUE_EXECUTION_MONITOR_CLEAR_REASONS,
  ISSUE_EXECUTION_MONITOR_KINDS,
  ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES,
  ISSUE_EXECUTION_MONITOR_STATE_STATUSES,
  ISSUE_EXECUTION_POLICY_MODES,
  ISSUE_EXECUTION_STAGE_TYPES,
  ISSUE_EXECUTION_STATE_STATUSES,
  ISSUE_COMMENT_AUTHOR_TYPES,
  ISSUE_COMMENT_METADATA_ROW_TYPES,
  ISSUE_COMMENT_PRESENTATION_KINDS,
  ISSUE_COMMENT_PRESENTATION_TONES,
  ISSUE_MONITOR_SCHEDULED_BY,
  ISSUE_PRIORITIES,
  ISSUE_WORK_MODES,
  clampIssueRequestDepth,
  ISSUE_STATUSES,
  ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES,
  ISSUE_THREAD_INTERACTION_KINDS,
  ISSUE_THREAD_INTERACTION_STATUSES,
  MODEL_PROFILE_KEYS,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const ISSUE_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
] as const;

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional(),
    environmentId: z.string().uuid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    modelProfile: z.enum(MODEL_PROFILE_KEYS).optional(),
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

const issueExecutionStagePrincipalBaseSchema = z.object({
  type: z.enum(["agent", "user"]),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
});

export const issueExecutionStagePrincipalSchema = issueExecutionStagePrincipalBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (!value.agentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
      }
      if (value.userId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
      }
      return;
    }
    if (!value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
    }
    if (value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
    }
  });

export const issueExecutionStageParticipantSchema = issueExecutionStagePrincipalBaseSchema.extend({
  id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
    }
    if (value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
  }
  if (value.agentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
  }
});

export const issueExecutionStageSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(ISSUE_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z.literal(1).optional().default(1),
  participants: z.array(issueExecutionStageParticipantSchema).default([]),
});

export const issueExecutionMonitorPolicySchema = z.object({
  nextCheckAt: z.string().datetime(),
  notes: z.string().max(500).optional().nullable().default(null),
  scheduledBy: z.enum(ISSUE_MONITOR_SCHEDULED_BY).optional().default("assignee"),
  kind: z.enum(ISSUE_EXECUTION_MONITOR_KINDS).optional().nullable().default(null),
  serviceName: z.string().trim().min(1).max(120).optional().nullable().default(null),
  externalRef: z.string().trim().min(1).max(500).optional().nullable().default(null),
  timeoutAt: z.string().datetime().optional().nullable().default(null),
  maxAttempts: z.number().int().positive().max(100).optional().nullable().default(null),
  recoveryPolicy: z.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).optional().nullable().default(null),
});

export const issueExecutionPolicySchema = z.object({
  mode: z.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(issueExecutionStageSchema).default([]),
  monitor: issueExecutionMonitorPolicySchema.optional().nullable(),
});

export const issueExecutionMonitorStateSchema = z.object({
  status: z.enum(ISSUE_EXECUTION_MONITOR_STATE_STATUSES),
  nextCheckAt: z.string().datetime().nullable(),
  lastTriggeredAt: z.string().datetime().nullable(),
  attemptCount: z.number().int().nonnegative().default(0),
  notes: z.string().max(500).nullable(),
  scheduledBy: z.enum(ISSUE_MONITOR_SCHEDULED_BY).nullable(),
  kind: z.enum(ISSUE_EXECUTION_MONITOR_KINDS).nullable().optional().default(null),
  serviceName: z.string().trim().min(1).max(120).nullable().optional().default(null),
  externalRef: z.string().trim().min(1).max(500).nullable().optional().default(null),
  timeoutAt: z.string().datetime().nullable().optional().default(null),
  maxAttempts: z.number().int().positive().max(100).nullable().optional().default(null),
  recoveryPolicy: z.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).nullable().optional().default(null),
  clearedAt: z.string().datetime().nullable(),
  clearReason: z.enum(ISSUE_EXECUTION_MONITOR_CLEAR_REASONS).nullable(),
});

export const issueReviewRequestSchema = z.object({
  instructions: z.string().trim().min(1).max(20000),
}).strict();

export const issueExecutionStateSchema = z.object({
  status: z.enum(ISSUE_EXECUTION_STATE_STATUSES),
  currentStageId: z.string().uuid().nullable(),
  currentStageIndex: z.number().int().nonnegative().nullable(),
  currentStageType: z.enum(ISSUE_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: issueExecutionStagePrincipalSchema.nullable(),
  returnAssignee: issueExecutionStagePrincipalSchema.nullable(),
  reviewRequest: issueReviewRequestSchema.nullable().optional().default(null),
  completedStageIds: z.array(z.string().uuid()).default([]),
  lastDecisionId: z.string().uuid().nullable(),
  lastDecisionOutcome: z.enum(ISSUE_EXECUTION_DECISION_OUTCOMES).nullable(),
  monitor: issueExecutionMonitorStateSchema.optional().nullable(),
});

const issueRequestDepthInputSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => clampIssueRequestDepth(value));

type IssueCreateStatusDefaultInput = {
  status?: unknown;
  assigneeAgentId?: unknown;
  assigneeUserId?: unknown;
};

export function resolveCreateIssueStatusDefault(input: IssueCreateStatusDefaultInput): {
  status: (typeof ISSUE_STATUSES)[number];
  defaulted: boolean;
  reason: "explicit" | "assigned_omitted_status" | "unassigned_omitted_status";
} {
  if (typeof input.status === "string") {
    return {
      status: input.status as (typeof ISSUE_STATUSES)[number],
      defaulted: false,
      reason: "explicit",
    };
  }

  const hasAssignee =
    (typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0)
    || (typeof input.assigneeUserId === "string" && input.assigneeUserId.length > 0);
  return {
    status: hasAssignee ? "todo" : "backlog",
    defaulted: true,
    reason: hasAssignee ? "assigned_omitted_status" : "unassigned_omitted_status",
  };
}

function withCreateIssueStatusDefault<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return z.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const raw = input as Record<string, unknown>;
    if (raw.status !== undefined) return input;
    return {
      ...raw,
      status: resolveCreateIssueStatusDefault(raw).status,
    };
  }, schema);
}

const createIssueBaseSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  blockedByIssueIds: z.array(z.string().uuid()).optional(),
  inheritExecutionWorkspaceFromIssueId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: multilineTextSchema.optional().nullable(),
  status: z.enum(ISSUE_STATUSES),
  workMode: z.enum(ISSUE_WORK_MODES).optional().default("standard"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: issueRequestDepthInputSchema.optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionPolicy: issueExecutionPolicySchema.optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export const createIssueInputSchema = createIssueBaseSchema.extend({
  status: createIssueBaseSchema.shape.status.optional(),
});

export const createIssueSchema = withCreateIssueStatusDefault(createIssueBaseSchema);

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createChildIssueSchema = withCreateIssueStatusDefault(createIssueBaseSchema
  .omit({
    parentId: true,
    inheritExecutionWorkspaceFromIssueId: true,
  })
  .extend({
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    blockParentUntilDone: z.boolean().optional().default(false),
  }));

export type CreateChildIssue = z.infer<typeof createChildIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const updateIssueSchema = createIssueBaseSchema.partial().extend({
  requestDepth: issueRequestDepthInputSchema.optional(),
  assigneeAgentId: z.string().trim().min(1).optional().nullable(),
  comment: multilineTextSchema.pipe(z.string().min(1)).optional(),
  reviewRequest: issueReviewRequestSchema.optional().nullable(),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

const commentMetadataLabelSchema = z.string().trim().min(1).max(120);
const commentMetadataTextSchema = z.string().trim().min(1).max(2000);

export const issueCommentAuthorTypeSchema = z.enum(ISSUE_COMMENT_AUTHOR_TYPES);

export const issueCommentPresentationSchema = z.object({
  kind: z.enum(ISSUE_COMMENT_PRESENTATION_KINDS).default("message"),
  tone: z.enum(ISSUE_COMMENT_PRESENTATION_TONES).default("neutral"),
  title: z.string().trim().min(1).max(160).nullable().optional(),
  detailsDefaultOpen: z.boolean().optional().default(false),
}).strict();

export type IssueCommentPresentation = z.infer<typeof issueCommentPresentationSchema>;

const issueCommentMetadataBaseRowSchema = z.object({
  type: z.enum(ISSUE_COMMENT_METADATA_ROW_TYPES),
  label: commentMetadataLabelSchema.nullable().optional(),
});

const issueCommentMetadataTextRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("text"),
  text: commentMetadataTextSchema,
}).strict();

const issueCommentMetadataCodeRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("code"),
  code: z.string().min(1).max(4000),
  language: z.string().trim().min(1).max(40).nullable().optional(),
}).strict();

const issueCommentMetadataKeyValueRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("key_value"),
  label: commentMetadataLabelSchema,
  value: commentMetadataTextSchema,
}).strict();

const issueCommentMetadataIssueLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("issue_link"),
  issueId: z.string().uuid().nullable().optional(),
  identifier: z.string().trim().min(1).max(80).nullable().optional(),
  title: z.string().trim().min(1).max(240).nullable().optional(),
}).strict();

const issueCommentMetadataAgentLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("agent_link"),
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

const issueCommentMetadataRunLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("run_link"),
  runId: z.string().uuid(),
  title: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

export const issueCommentMetadataRowSchema = z.discriminatedUnion("type", [
  issueCommentMetadataTextRowSchema,
  issueCommentMetadataCodeRowSchema,
  issueCommentMetadataKeyValueRowSchema,
  issueCommentMetadataIssueLinkRowSchema,
  issueCommentMetadataAgentLinkRowSchema,
  issueCommentMetadataRunLinkRowSchema,
]).superRefine((value, ctx) => {
  if (value.type === "issue_link" && !value.issueId && !value.identifier) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Issue link rows require issueId or identifier",
      path: ["issueId"],
    });
  }
});

export const issueCommentMetadataSectionSchema = z.object({
  title: z.string().trim().min(1).max(160).nullable().optional(),
  rows: z.array(issueCommentMetadataRowSchema).min(1).max(50),
}).strict();

export const issueCommentMetadataSchema = z.object({
  version: z.literal(1),
  sourceRunId: z.string().uuid().nullable().optional(),
  sections: z.array(issueCommentMetadataSectionSchema).min(1).max(20),
}).strict();

export type IssueCommentMetadata = z.infer<typeof issueCommentMetadataSchema>;

export const addIssueCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
  authorType: issueCommentAuthorTypeSchema.optional(),
  presentation: issueCommentPresentationSchema.nullable().optional(),
  metadata: issueCommentMetadataSchema.nullable().optional(),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const issueThreadInteractionStatusSchema = z.enum(ISSUE_THREAD_INTERACTION_STATUSES);
export const issueThreadInteractionKindSchema = z.enum(ISSUE_THREAD_INTERACTION_KINDS);
export const issueThreadInteractionContinuationPolicySchema = z.enum(
  ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES,
);

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const suggestedTaskDraftSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  parentClientKey: z.string().trim().min(1).max(120).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240),
  description: multilineTextSchema.pipe(z.string().trim().max(20000)).nullable().optional(),
  priority: z.enum(ISSUE_PRIORITIES).nullable().optional(),
  workMode: z.enum(ISSUE_WORK_MODES).nullable().optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().trim().min(1).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  billingCode: z.string().trim().max(120).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  hiddenInPreview: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.assigneeAgentId && value.assigneeUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Suggested tasks can only target one assignee",
      path: ["assigneeAgentId"],
    });
  }
});

export const suggestTasksPayloadSchema = z.object({
  version: z.literal(1),
  defaultParentId: z.string().uuid().nullable().optional(),
  tasks: z.array(suggestedTaskDraftSchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seenClientKeys.has(task.clientKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clientKey must be unique within one interaction",
        path: ["tasks", index, "clientKey"],
      });
      continue;
    }
    seenClientKeys.add(task.clientKey);
  }
});

export const suggestTasksResultCreatedTaskSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  issueId: z.string().uuid(),
  identifier: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).nullable().optional(),
  parentIssueId: z.string().uuid().nullable().optional(),
  parentIdentifier: z.string().trim().min(1).nullable().optional(),
});

export const suggestTasksResultSchema = z.object({
  version: z.literal(1),
  createdTasks: z.array(suggestTasksResultCreatedTaskSchema).max(50).optional(),
  skippedClientKeys: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  rejectionReason: z.string().trim().max(4000).nullable().optional(),
});

export const askUserQuestionsQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

export const askUserQuestionsQuestionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(500),
  helpText: z.string().trim().max(1000).nullable().optional(),
  selectionMode: z.enum(["single", "multi"]),
  required: z.boolean().optional(),
  options: z.array(askUserQuestionsQuestionOptionSchema).min(1).max(10),
});

export const askUserQuestionsPayloadSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().max(240).nullable().optional(),
  submitLabel: z.string().trim().max(120).nullable().optional(),
  questions: z.array(askUserQuestionsQuestionSchema).min(1).max(10),
}).superRefine((value, ctx) => {
  const seenQuestionIds = new Set<string>();
  for (const [questionIndex, question] of value.questions.entries()) {
    if (seenQuestionIds.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question ids must be unique within one interaction",
        path: ["questions", questionIndex, "id"],
      });
    }
    seenQuestionIds.add(question.id);

    const seenOptionIds = new Set<string>();
    for (const [optionIndex, option] of question.options.entries()) {
      if (seenOptionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Option ids must be unique within one question",
          path: ["questions", questionIndex, "options", optionIndex, "id"],
        });
      }
      seenOptionIds.add(option.id);
    }
  }
});

export const askUserQuestionsAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(120),
  optionIds: z.array(z.string().trim().min(1).max(120)).max(20),
});

export const askUserQuestionsResultSchema = z.object({
  version: z.literal(1),
  answers: z.array(askUserQuestionsAnswerSchema).max(20),
  cancelled: z.literal(true).optional(),
  cancellationReason: z.string().trim().max(4000).nullable().optional(),
  summaryMarkdown: z.string().max(20000).nullable().optional(),
});

const requestConfirmationHrefSchema = z.string().trim().min(1).max(2000).refine((value) => {
  const lower = value.toLowerCase();
  return !lower.startsWith("javascript:")
    && !lower.startsWith("data:")
    && !value.startsWith("//");
}, "href must not use javascript:, data:, or protocol-relative URLs");

const requestConfirmationTargetBaseSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable().optional(),
  href: requestConfirmationHrefSchema.nullable().optional(),
});

export const requestConfirmationIssueDocumentTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z.literal("issue_document"),
  issueId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  key: issueDocumentKeySchema,
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive().nullable().optional(),
});

export const requestConfirmationCustomTargetSchema = requestConfirmationTargetBaseSchema.extend({
  type: z.literal("custom"),
  key: z.string().trim().min(1).max(120),
  revisionId: z.string().trim().min(1).max(255).nullable().optional(),
  revisionNumber: z.number().int().positive().nullable().optional(),
});

export const requestConfirmationTargetSchema = z.discriminatedUnion("type", [
  requestConfirmationIssueDocumentTargetSchema,
  requestConfirmationCustomTargetSchema,
]);

export const requestConfirmationPayloadSchema = z.object({
  version: z.literal(1),
  prompt: z.string().trim().min(1).max(1000),
  acceptLabel: z.string().trim().min(1).max(80).nullable().optional(),
  rejectLabel: z.string().trim().min(1).max(80).nullable().optional(),
  rejectRequiresReason: z.boolean().optional(),
  rejectReasonLabel: z.string().trim().min(1).max(160).nullable().optional(),
  allowDeclineReason: z.boolean().optional().default(true),
  declineReasonPlaceholder: z.string().trim().min(1).max(240).nullable().optional(),
  detailsMarkdown: z.string().max(20000).nullable().optional(),
  supersedeOnUserComment: z.boolean().optional(),
  target: requestConfirmationTargetSchema.nullable().optional(),
});

export const requestConfirmationResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(["accepted", "rejected", "superseded_by_comment", "stale_target"]),
  reason: z.string().trim().max(4000).nullable().optional(),
  commentId: z.string().uuid().nullable().optional(),
  staleTarget: requestConfirmationTargetSchema.nullable().optional(),
});

export const createIssueThreadInteractionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("suggest_tasks"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: suggestTasksPayloadSchema,
  }),
  z.object({
    kind: z.literal("ask_user_questions"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
    payload: askUserQuestionsPayloadSchema,
  }),
  z.object({
    kind: z.literal("request_confirmation"),
    idempotencyKey: z.string().trim().max(255).nullable().optional(),
    sourceCommentId: z.string().uuid().nullable().optional(),
    sourceRunId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(240).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
    payload: requestConfirmationPayloadSchema,
  }),
]);

export type CreateIssueThreadInteraction = z.infer<typeof createIssueThreadInteractionSchema>;

export const acceptIssueThreadInteractionSchema = z.object({
  selectedClientKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, clientKey] of (value.selectedClientKeys ?? []).entries()) {
    if (seenClientKeys.has(clientKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectedClientKeys must be unique",
        path: ["selectedClientKeys", index],
      });
      continue;
    }
    seenClientKeys.add(clientKey);
  }
});
export type AcceptIssueThreadInteraction = z.infer<typeof acceptIssueThreadInteractionSchema>;

export const rejectIssueThreadInteractionSchema = z.object({
  reason: z.string().trim().max(4000).optional(),
});
export type RejectIssueThreadInteraction = z.infer<typeof rejectIssueThreadInteractionSchema>;

export const cancelIssueThreadInteractionSchema = z.object({
  reason: z.string().trim().max(4000).optional(),
});
export type CancelIssueThreadInteraction = z.infer<typeof cancelIssueThreadInteractionSchema>;

export const respondIssueThreadInteractionSchema = z.object({
  answers: z.array(askUserQuestionsAnswerSchema).max(20),
  summaryMarkdown: multilineTextSchema.pipe(z.string().max(20000)).nullable().optional(),
});
export type RespondIssueThreadInteraction = z.infer<typeof respondIssueThreadInteractionSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const ISSUE_DOCUMENT_FORMATS = ["markdown"] as const;

export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: multilineTextSchema.pipe(z.string().max(524288)),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreIssueDocumentRevisionSchema = z.object({});

export type IssueDocumentFormat = z.infer<typeof issueDocumentFormatSchema>;
export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;
export type RestoreIssueDocumentRevision = z.infer<typeof restoreIssueDocumentRevisionSchema>;
