import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const optionalUuid = z.string().uuid().nullable().optional();
const jsonRecord = z.record(z.unknown());

export const PAPERCLIP_SESSION_DOCUMENT_KEY = "session" as const;
export const PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX = "session-receipt-" as const;
export const PAPERCLIP_SESSION_SCHEMA_VERSION = 1 as const;

export const paperclipSessionTypeSchema = z.enum(["working", "review", "eod", "ad_hoc"]);
export const paperclipSessionStateSchema = z.enum([
  "draft",
  "open",
  "waiting_response",
  "reviewing",
  "accepted",
  "rejected",
  "redirected",
  "completed",
  "blocked",
  "rollback_disabled",
  "cancelled",
]);
export const paperclipSessionTransitionSchema = z.enum([
  "create",
  "open",
  "request_response",
  "respond",
  "mark_missed",
  "challenge",
  "accept",
  "reject",
  "redirect",
  "dispose_finding",
  "route_task",
  "redact_receipt",
  "reopen",
  "complete",
  "block",
  "rollback_disable",
  "cancel",
]);
export const paperclipSessionParticipantStatusSchema = z.enum([
  "pending",
  "acknowledged",
  "responded",
  "missed",
  "excused",
]);
export const paperclipSessionReceiptVisibilitySchema = z.enum(["manager_audit", "participant_redacted"]);
export const paperclipTaskRouteAuthorityPathSchema = z.enum(["direct", "service", "multi_actor_fallback", "failed_router"]);
export const paperclipAdHocTriggerClassSchema = z.enum([
  "standup_nonresponse",
  "repeated_unanswered_directive",
  "full_paper_work_halt",
  "generator_nonproductive_state",
  "failed_or_stalled_review",
  "runtime_risk",
  "material_super_pass_event",
  "eod_material_finding",
  "permission_or_task_router_blocker",
]);

export const paperclipSessionActorSchema = z
  .object({
    actorType: z.enum(["board", "agent", "service"]),
    actorId: nonEmptyString,
    agentId: optionalUuid,
    userId: z.string().nullable().optional(),
    runId: optionalUuid,
  })
  .strict();

export const paperclipSessionParticipantSchema = z
  .object({
    role: nonEmptyString,
    agentId: optionalUuid,
    issueId: optionalUuid,
    status: paperclipSessionParticipantStatusSchema,
    responseId: z.string().nullable().optional(),
    missedReason: z.string().nullable().optional(),
  })
  .strict();

export const paperclipSessionSourceSchema = z
  .object({
    triggerClass: paperclipAdHocTriggerClassSchema.nullable().optional(),
    source: nonEmptyString,
    sourceId: z.string().nullable().optional(),
    snapshot: jsonRecord.optional(),
    collectedAt: z.string().datetime().nullable().optional(),
    freshnessSeconds: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const paperclipSessionReceiptSchema = z
  .object({
    receiptId: nonEmptyString,
    auditId: nonEmptyString,
    visibility: paperclipSessionReceiptVisibilitySchema,
    issueId: optionalUuid,
    documentId: optionalUuid,
    commentId: optionalUuid,
    redacted: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const paperclipTaskRouteReceiptSchema = z
  .object({
    routeId: nonEmptyString,
    authorityPath: paperclipTaskRouteAuthorityPathSchema,
    companyId: z.string().uuid(),
    policyKey: nonEmptyString,
    sessionType: paperclipSessionTypeSchema,
    sourceFindingId: nonEmptyString,
    intendedOwnerRole: nonEmptyString,
    targetRole: nonEmptyString,
    createdIssueId: optionalUuid,
    actor: paperclipSessionActorSchema,
    serviceRunId: optionalUuid,
    routerRevoked: z.boolean().optional().default(false),
    blockedReason: z.string().nullable().optional(),
  })
  .strict();

export const paperclipSessionReviewSchema = z
  .object({
    domain: nonEmptyString,
    challenge: z.string().trim().min(1).nullable().optional(),
    disposition: z.enum(["accepted", "rejected", "redirected", "not_applicable"]).nullable().optional(),
    dispositionReason: z.string().trim().min(1).nullable().optional(),
    downstreamOwnerRole: nonEmptyString.nullable().optional(),
  })
  .strict();

export const paperclipSessionEodFindingSchema = z
  .object({
    findingId: nonEmptyString,
    summary: z.string().trim().min(1),
    disposition: z.enum(["task", "ad_hoc_meeting", "system_change", "accepted_risk", "no_op", "rejected"]),
    ownerRole: nonEmptyString.nullable().optional(),
    reason: z.string().trim().min(1),
    taskRouteId: z.string().nullable().optional(),
  })
  .strict();

export const paperclipSessionHealthObservationSchema = z
  .object({
    observationId: nonEmptyString,
    status: z.enum(["healthy", "degraded", "blocked"]),
    checkedAt: z.string().datetime(),
    ownerRole: nonEmptyString,
    cadence: nonEmptyString,
    alertTarget: nonEmptyString,
    recoveryAction: nonEmptyString,
    signals: jsonRecord.optional(),
  })
  .strict();

export const paperclipSessionDocumentSchema = z
  .object({
    schemaVersion: z.literal(PAPERCLIP_SESSION_SCHEMA_VERSION),
    policyKey: nonEmptyString,
    policyVersion: nonEmptyString,
    companyId: z.string().uuid(),
    issueId: z.string().uuid(),
    sessionType: paperclipSessionTypeSchema,
    state: paperclipSessionStateSchema,
    stateRevision: z.number().int().nonnegative(),
    idempotencyKey: nonEmptyString,
    objective: z.string().trim().min(1),
    source: paperclipSessionSourceSchema,
    participants: z.array(paperclipSessionParticipantSchema).min(1),
    receipts: z.array(paperclipSessionReceiptSchema).optional().default([]),
    taskRoutes: z.array(paperclipTaskRouteReceiptSchema).optional().default([]),
    reviews: z.array(paperclipSessionReviewSchema).optional().default([]),
    eodFindings: z.array(paperclipSessionEodFindingSchema).optional().default([]),
    health: z.array(paperclipSessionHealthObservationSchema).optional().default([]),
    lastTransition: z
      .object({
        transitionId: z.string().uuid(),
        transition: paperclipSessionTransitionSchema,
        actor: paperclipSessionActorSchema,
        beforeState: paperclipSessionStateSchema.nullable(),
        afterState: paperclipSessionStateSchema,
        at: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export const paperclipSessionTransitionReceiptDocumentSchema = z
  .object({
    schemaVersion: z.literal(PAPERCLIP_SESSION_SCHEMA_VERSION),
    receiptType: z.literal("session_transition"),
    recordedBy: z.literal("paperclip-session-service"),
    companyId: z.string().uuid(),
    issueId: z.string().uuid(),
    policyKey: nonEmptyString,
    policyVersion: nonEmptyString,
    sessionType: paperclipSessionTypeSchema,
    sessionDocumentId: z.string().uuid(),
    sessionRevisionId: z.string().uuid(),
    stateRevision: z.number().int().nonnegative(),
    idempotencyKey: nonEmptyString,
    transitionId: z.string().uuid(),
    transition: paperclipSessionTransitionSchema,
    actor: paperclipSessionActorSchema,
    beforeState: paperclipSessionStateSchema.nullable(),
    afterState: paperclipSessionStateSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const paperclipSessionTransitionRequestSchema = z
  .object({
    issueId: z.string().uuid(),
    expectedRevisionId: optionalUuid,
    expectedState: paperclipSessionStateSchema.nullable().optional(),
    transition: paperclipSessionTransitionSchema,
    nextState: paperclipSessionDocumentSchema,
    actor: paperclipSessionActorSchema,
    idempotencyKey: nonEmptyString,
  })
  .strict();

export const paperclipSessionResponseRequestSchema = z
  .object({
    issueId: z.string().uuid(),
    participantAgentId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    response: jsonRecord,
    actor: paperclipSessionActorSchema,
  })
  .strict();

export const paperclipSessionInspectRequestSchema = z
  .object({
    issueId: z.string().uuid(),
    includeReceipts: z.boolean().optional().default(true),
    actor: paperclipSessionActorSchema.optional(),
  })
  .strict();

export const paperclipSessionReceiptRedactionSchema = z
  .object({
    auditId: nonEmptyString,
    managerReceipt: jsonRecord,
    participantReceipt: jsonRecord,
    redactedFields: z.array(nonEmptyString),
  })
  .strict();

export const paperclipSessionRollbackDisableRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    policyKey: nonEmptyString,
    sessionType: paperclipSessionTypeSchema,
    triggerClass: paperclipAdHocTriggerClassSchema,
    expectedNoNewSessionProof: nonEmptyString,
    actor: paperclipSessionActorSchema,
  })
  .strict();

export const paperclipLinkedSessionRoutineParticipantSchema = z
  .object({
    role: nonEmptyString,
    agentId: z.string().uuid(),
  })
  .strict();

export const paperclipLinkedSessionRoutinePolicySchema = z
  .object({
    policyKey: nonEmptyString,
    policyVersion: nonEmptyString,
    sessionType: paperclipSessionTypeSchema,
    objective: z.string().trim().min(1),
    participants: z.array(paperclipLinkedSessionRoutineParticipantSchema).min(1),
    source: paperclipSessionSourceSchema.optional(),
  })
  .strict();

export const paperclipSessionTaskRouteRequestSchema = z
  .object({
    issueId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    sourceFindingId: nonEmptyString,
    intendedOwnerRole: nonEmptyString,
    targetRole: nonEmptyString,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10_000),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
    assigneeAgentId: optionalUuid,
    serviceRunId: optionalUuid,
    allowDirectFallback: z.boolean().optional().default(false),
    actor: paperclipSessionActorSchema,
  })
  .strict();

export const paperclipSessionReceiptRedactionRequestSchema = z
  .object({
    issueId: z.string().uuid(),
    expectedRevisionId: z.string().uuid(),
    redaction: paperclipSessionReceiptRedactionSchema,
    actor: paperclipSessionActorSchema,
  })
  .strict();

export const carSessionTriggerEvaluationRequestSchema = z
  .object({
    triggerClass: paperclipAdHocTriggerClassSchema,
    severityInputs: jsonRecord,
    dedupeKey: nonEmptyString,
    openSessionCount: z.number().int().nonnegative().optional().default(0),
    openTaskCount: z.number().int().nonnegative().optional().default(0),
    sessionCap: z.number().int().positive().optional().default(3),
    taskCap: z.number().int().positive().optional().default(12),
    correctionTarget: z.string().nullable().optional(),
    reopenTarget: z.string().nullable().optional(),
  })
  .strict();

export const carSessionTriggerSpecSchema = z
  .object({
    triggerClass: paperclipAdHocTriggerClassSchema,
    detector: nonEmptyString,
    source: nonEmptyString,
    severityInputs: z.array(nonEmptyString).min(1),
    dedupeKeyFields: z.array(nonEmptyString).min(1),
    capRule: nonEmptyString,
    overloadRule: nonEmptyString,
    correctionRule: nonEmptyString,
    reopenRule: nonEmptyString,
    noOpRule: nonEmptyString,
    ownerRole: nonEmptyString,
    persistentCompletionExpiry: z.string().datetime().nullable().optional(),
  })
  .strict();

export const carSessionPolicySchema = z
  .object({
    schemaVersion: z.literal(PAPERCLIP_SESSION_SCHEMA_VERSION),
    policyKey: nonEmptyString,
    policyVersion: nonEmptyString,
    companyId: z.string().uuid(),
    timezone: nonEmptyString,
    requiredRoles: z.array(nonEmptyString).min(1),
    sessionTypes: z.array(paperclipSessionTypeSchema).min(1),
    reviewDomains: z.array(nonEmptyString).min(1),
    eodDispositions: z.array(nonEmptyString).min(1),
    noLiveCapitalBoundary: z.boolean(),
    taskAuthority: z
      .object({
        directPermission: z.literal("tasks:assign"),
        servicePolicyKey: nonEmptyString,
        routerKillSwitchKey: nonEmptyString,
      })
      .strict(),
    caps: jsonRecord,
    freshnessSlaSeconds: jsonRecord,
    r5Triggers: z.array(carSessionTriggerSpecSchema).length(9),
    disableSettings: jsonRecord,
  })
  .strict();

export type PaperclipSessionType = z.infer<typeof paperclipSessionTypeSchema>;
export type PaperclipSessionState = z.infer<typeof paperclipSessionStateSchema>;
export type PaperclipSessionTransition = z.infer<typeof paperclipSessionTransitionSchema>;
export type PaperclipSessionActor = z.infer<typeof paperclipSessionActorSchema>;
export type PaperclipSessionDocument = z.infer<typeof paperclipSessionDocumentSchema>;
export type PaperclipSessionTransitionReceiptDocument = z.infer<typeof paperclipSessionTransitionReceiptDocumentSchema>;
export type PaperclipSessionTransitionRequest = z.infer<typeof paperclipSessionTransitionRequestSchema>;
export type PaperclipSessionResponseRequest = z.infer<typeof paperclipSessionResponseRequestSchema>;
export type PaperclipSessionInspectRequest = z.infer<typeof paperclipSessionInspectRequestSchema>;
export type PaperclipSessionReceiptRedaction = z.infer<typeof paperclipSessionReceiptRedactionSchema>;
export type PaperclipSessionReceiptRedactionRequest = z.infer<typeof paperclipSessionReceiptRedactionRequestSchema>;
export type PaperclipSessionRollbackDisableRequest = z.infer<typeof paperclipSessionRollbackDisableRequestSchema>;
export type PaperclipSessionTaskRouteRequest = z.infer<typeof paperclipSessionTaskRouteRequestSchema>;
export type PaperclipTaskRouteReceipt = z.infer<typeof paperclipTaskRouteReceiptSchema>;
export type PaperclipSessionHealthObservation = z.infer<typeof paperclipSessionHealthObservationSchema>;
export type PaperclipLinkedSessionRoutinePolicy = z.infer<typeof paperclipLinkedSessionRoutinePolicySchema>;
export type CarSessionTriggerEvaluationRequest = z.infer<typeof carSessionTriggerEvaluationRequestSchema>;
export type CarSessionPolicy = z.infer<typeof carSessionPolicySchema>;
export type CarSessionTriggerSpec = z.infer<typeof carSessionTriggerSpecSchema>;
