import { z } from "zod";

export const rt2TaskModeSchema = z.enum(["solo", "collab"]);
export const rt2ParticipantStateSchema = z.enum(["active", "ended"]);
export const rt2ParticipantEndReasonSchema = z.enum(["manager_removed", "self_left", "capacity_reduced"]);
export const rt2DeliverableKindSchema = z.enum(["document", "artifact"]);
export const rt2DeliverableStateSchema = z.enum(["defined", "submitted"]);
export const rt2ExecutionStateSchema = z.enum([
  "queued",
  "dispatched",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);
export const rt2ExecutionExecutorTypeSchema = z.enum(["user", "jarvis", "runtime"]);

export const rt2DeliverableInputSchema = z.object({
  title: z.string().trim().min(1),
  type: rt2DeliverableKindSchema,
  basePrice: z.number().int().min(0),
  summary: z.string().trim().min(1).nullable().optional(),
});

export const createRt2TaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1),
  goalId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  taskMode: rt2TaskModeSchema,
  capacity: z.number().int().min(1),
  deliverables: z.array(rt2DeliverableInputSchema).min(1),
});

export type CreateRt2Task = z.infer<typeof createRt2TaskSchema>;

export const oneLinerInboundDraftSourceSchema = z.enum(["web", "floating", "voice", "slack", "teams", "webhook", "mobile", "native"]);
export const rt2MessagingInboundSourceSchema = z.enum(["slack", "teams", "webhook"]);
export const rt2CaptureDraftStatusSchema = z.enum([
  "review_required",
  "revised",
  "on_hold",
  "revision_requested",
  "rejected",
  "duplicate",
  "permission_blocked",
  "failed",
  "promoted",
  "discarded",
]);
export const rt2CaptureQueueEvidenceFilterSchema = z.enum(["duplicate", "failed_sync", "approval_waiting", "revised"]);
export const rt2CaptureQueueQuerySchema = z
  .object({
    source: z.union([z.string(), z.array(z.string())]).optional(),
    sources: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.union([z.string(), z.array(z.string())]).optional(),
    statuses: z.union([z.string(), z.array(z.string())]).optional(),
    evidence: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough()
  .transform((value) => ({
    sources: filterKnownCaptureValues(
      mergeQueryLists(value.source, value.sources),
      oneLinerInboundDraftSourceSchema,
    ),
    statuses: filterKnownCaptureValues(
      mergeQueryLists(value.status, value.statuses),
      rt2CaptureDraftStatusSchema,
    ),
    evidence: filterKnownCaptureValues(
      mergeQueryLists(value.evidence),
      rt2CaptureQueueEvidenceFilterSchema,
    ),
  }));
export type Rt2CaptureQueueQuery = z.infer<typeof rt2CaptureQueueQuerySchema>;
export const rt2CaptureSourceInstallationStateSchema = z.enum(["not_installed", "installed", "blocked", "stale", "error"]);
export const rt2CaptureSourceSigningStatusSchema = z.enum(["unsigned", "signed", "invalid", "missing", "stale"]);
export const rt2CaptureSourceEvidenceMetadataSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .transform((metadata) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 20)) {
      const cleanKey = key.trim().slice(0, 80);
      if (!cleanKey || value == null) continue;
      if (/token|secret|signature|authorization|password/i.test(cleanKey)) continue;
      result[cleanKey] = String(value).trim().slice(0, 500);
    }
    return result;
  });

export const upsertRt2CaptureSourceSchema = z.object({
  source: oneLinerInboundDraftSourceSchema,
  label: z.string().trim().min(1).max(120).optional(),
  installationState: rt2CaptureSourceInstallationStateSchema.default("installed"),
  signingStatus: rt2CaptureSourceSigningStatusSchema.default("unsigned"),
  signingSecret: z.string().trim().min(8).max(500).optional(),
  blockedReason: z.string().trim().min(1).max(1000).nullable().optional(),
  lastErrorCode: z.string().trim().min(1).max(120).nullable().optional(),
});

export type UpsertRt2CaptureSource = z.infer<typeof upsertRt2CaptureSourceSchema>;

function splitQueryList(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.flatMap((entry) =>
    entry
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function mergeQueryLists(...values: Array<string | string[] | undefined>) {
  return [...new Set(values.flatMap(splitQueryList))];
}

function filterKnownCaptureValues<T extends string>(
  values: string[],
  schema: z.ZodEnum<[T, ...T[]]>,
): T[] {
  return values.filter((value): value is T => schema.safeParse(value).success);
}

export const createOneLinerInboundDraftSchema = z.object({
  source: oneLinerInboundDraftSourceSchema.default("webhook"),
  text: z.string().trim().min(1),
  channel: z.string().trim().min(1).max(120).nullable().optional(),
  externalUserId: z.string().trim().min(1).max(200).nullable().optional(),
  sourceInstallationId: z.string().uuid().nullable().optional(),
  eventId: z.string().trim().min(1).max(200).nullable().optional(),
  eventTimestamp: z.string().datetime().nullable().optional(),
  signature: z.string().trim().min(1).max(500).nullable().optional(),
  metadata: rt2CaptureSourceEvidenceMetadataSchema.optional(),
});

export type CreateOneLinerInboundDraft = z.infer<typeof createOneLinerInboundDraftSchema>;

export const createRt2MessagingInboundSchema = z.object({
  text: z.string().trim().min(1).max(5000).nullable().optional(),
  messageText: z.string().trim().min(1).max(5000).nullable().optional(),
  channel: z.string().trim().min(1).max(120).nullable().optional(),
  channelId: z.string().trim().min(1).max(120).nullable().optional(),
  channel_id: z.string().trim().min(1).max(120).nullable().optional(),
  externalUserId: z.string().trim().min(1).max(200).nullable().optional(),
  userId: z.string().trim().min(1).max(200).nullable().optional(),
  user_id: z.string().trim().min(1).max(200).nullable().optional(),
  sourceInstallationId: z.string().uuid().nullable().optional(),
  eventId: z.string().trim().min(1).max(200).nullable().optional(),
  event_id: z.string().trim().min(1).max(200).nullable().optional(),
  messageId: z.string().trim().min(1).max(200).nullable().optional(),
  eventTimestamp: z.string().datetime().nullable().optional(),
  timestamp: z.string().trim().min(1).max(120).nullable().optional(),
  signature: z.string().trim().min(1).max(500).nullable().optional(),
  teamId: z.string().trim().min(1).max(120).nullable().optional(),
  team_id: z.string().trim().min(1).max(120).nullable().optional(),
  tenantId: z.string().trim().min(1).max(120).nullable().optional(),
  tenant_id: z.string().trim().min(1).max(120).nullable().optional(),
  threadId: z.string().trim().min(1).max(200).nullable().optional(),
  thread_ts: z.string().trim().min(1).max(200).nullable().optional(),
  permalink: z.string().trim().max(500).nullable().optional(),
  metadata: rt2CaptureSourceEvidenceMetadataSchema.optional(),
}).passthrough();

export type CreateRt2MessagingInbound = z.infer<typeof createRt2MessagingInboundSchema>;

export const rt2CaptureDraftRevisionSnapshotSchema = z.object({
  taskTitle: z.string().trim().min(1).max(300),
  todoTitle: z.string().trim().max(300).optional().default(""),
  deliverableTitle: z.string().trim().min(1).max(300),
  deliverableType: rt2DeliverableKindSchema.default("document"),
  basePrice: z.number().int().min(0).nullable().optional(),
  taskMode: rt2TaskModeSchema.default("solo"),
  capacity: z.number().int().min(1).default(1),
  qualityHint: z.string().trim().max(120).nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  okrCandidate: z.string().trim().max(300).nullable().optional(),
  sourceEvidenceNote: z.string().trim().max(1000).nullable().optional(),
  operatorNote: z.string().trim().max(1000).nullable().optional(),
}).strict();

export const reviseRt2CaptureDraftSchema = z.object({
  snapshot: rt2CaptureDraftRevisionSnapshotSchema,
  changeSummary: z.string().trim().min(1).max(1000).optional(),
}).strict();

export type ReviseRt2CaptureDraft = z.infer<typeof reviseRt2CaptureDraftSchema>;

export const transitionRt2CaptureDraftSchema = z.object({
  action: z.enum(["hold", "reject", "request_revision", "mark_review_required"]),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action !== "mark_review_required" && !value.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reason is required for hold, reject, and request_revision",
      path: ["reason"],
    });
  }
});

export type TransitionRt2CaptureDraft = z.infer<typeof transitionRt2CaptureDraftSchema>;

export const rt2BoardQualityStatusSchema = z.enum(["none", "pending_review", "reviewed", "needs_work"]);

export const updateRt2BoardCardSchema = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  qualityStatus: rt2BoardQualityStatusSchema.optional(),
  priceGold: z.number().int().min(0).nullable().optional(),
  detailNotes: z.string().trim().max(2000).nullable().optional(),
}).strict();

export type UpdateRt2BoardCard = z.infer<typeof updateRt2BoardCardSchema>;

export const createRt2BoardChecklistItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export type CreateRt2BoardChecklistItem = z.infer<typeof createRt2BoardChecklistItemSchema>;

export const updateRt2BoardChecklistItemSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  checked: z.boolean().optional(),
});

export type UpdateRt2BoardChecklistItem = z.infer<typeof updateRt2BoardChecklistItemSchema>;

export const reorderRt2BoardChecklistSchema = z.object({
  orderedItemIds: z.array(z.string().uuid()).min(1),
});

export type ReorderRt2BoardChecklist = z.infer<typeof reorderRt2BoardChecklistSchema>;

export const createRt2BoardAttachmentSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().url(),
  contentType: z.string().trim().min(1).max(120).nullable().optional(),
});

export type CreateRt2BoardAttachment = z.infer<typeof createRt2BoardAttachmentSchema>;

export const promoteRt2CaptureDraftSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("task"),
    projectId: z.string().uuid(),
    goalId: z.string().uuid().nullable().optional(),
    taskMode: rt2TaskModeSchema.default("solo"),
    capacity: z.number().int().min(1).default(1),
    priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  }),
  z.object({
    target: z.literal("todo"),
    taskIssueId: z.string().uuid(),
    assigneeUserId: z.string().trim().min(1),
  }),
  z.object({
    target: z.literal("deliverable"),
    issueId: z.string().uuid(),
  }),
]);

export type PromoteRt2CaptureDraft = z.infer<typeof promoteRt2CaptureDraftSchema>;

export const failRt2CaptureDraftSchema = z.object({
  failureCode: z.enum(["source_failure", "duplicate", "permission", "parse_error"]),
  failureMessage: z.string().trim().min(1).max(1000),
});

export type FailRt2CaptureDraft = z.infer<typeof failRt2CaptureDraftSchema>;

export const createRt2TodoSchema = z.object({
  taskIssueId: z.string().uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  assigneeUserId: z.string().trim().min(1),
  deliverables: z.array(rt2DeliverableInputSchema).min(1),
});

export type CreateRt2Todo = z.infer<typeof createRt2TodoSchema>;

export const assignRt2ParticipantSchema = z.object({
  userId: z.string().trim().min(1),
});

export type AssignRt2Participant = z.infer<typeof assignRt2ParticipantSchema>;

export const updateRt2TaskCapacitySchema = z.object({
  capacity: z.number().int().min(1),
  endedUserIds: z.array(z.string().trim().min(1)).default([]),
});

export type UpdateRt2TaskCapacity = z.infer<typeof updateRt2TaskCapacitySchema>;

export const endRt2ParticipantSchema = z.object({
  reason: rt2ParticipantEndReasonSchema,
});

export type EndRt2Participant = z.infer<typeof endRt2ParticipantSchema>;

export const enqueueRt2ExecutionSchema = z.object({
  todoIssueId: z.string().uuid().nullable().optional(),
  deliverableWorkProductId: z.string().uuid().nullable().optional(),
  executionWorkspaceId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type EnqueueRt2Execution = z.infer<typeof enqueueRt2ExecutionSchema>;

const rt2ExecutionDispatcherSchema = z.object({
  executorType: rt2ExecutionExecutorTypeSchema,
  executorId: z.string().trim().min(1),
  executionWorkspaceId: z.string().uuid().nullable().optional(),
  runtimeServiceId: z.string().uuid().nullable().optional(),
  heartbeatRunId: z.string().uuid().nullable().optional(),
});

export const claimRt2ExecutionSchema = rt2ExecutionDispatcherSchema;
export type ClaimRt2Execution = z.infer<typeof claimRt2ExecutionSchema>;

export const dispatchRt2ExecutionSchema = rt2ExecutionDispatcherSchema.extend({
  capacity: z.number().int().min(1).max(100).optional(),
  runtimeFreshnessSeconds: z.number().int().min(1).max(86_400).optional(),
});

export type DispatchRt2Execution = z.infer<typeof dispatchRt2ExecutionSchema>;

export const dispatchNextRt2ExecutionSchema = dispatchRt2ExecutionSchema;

export type DispatchNextRt2Execution = z.infer<typeof dispatchNextRt2ExecutionSchema>;

export const startRt2ExecutionSchema = z.object({
  runtimeServiceId: z.string().uuid().nullable().optional(),
  heartbeatRunId: z.string().uuid().nullable().optional(),
});

export type StartRt2Execution = z.infer<typeof startRt2ExecutionSchema>;

export const completeRt2ExecutionSchema = z
  .object({
    resultWorkProductId: z.string().uuid().nullable().optional(),
    missingDeliverableReason: z.string().trim().min(1).nullable().optional(),
  })
  .refine((value) => Boolean(value.resultWorkProductId || value.missingDeliverableReason), {
    message: "resultWorkProductId or missingDeliverableReason is required",
  });

export type CompleteRt2Execution = z.infer<typeof completeRt2ExecutionSchema>;

export const failRt2ExecutionSchema = z.object({
  failureReason: z.string().trim().min(1),
});

export type FailRt2Execution = z.infer<typeof failRt2ExecutionSchema>;

export const cancelRt2ExecutionSchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
  cancelledBy: z.string().trim().min(1).max(200).optional(),
});

export type CancelRt2Execution = z.infer<typeof cancelRt2ExecutionSchema>;

export const cleanupRt2ExecutionsSchema = z.object({
  staleBefore: z.string().datetime().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type CleanupRt2Executions = z.infer<typeof cleanupRt2ExecutionsSchema>;
