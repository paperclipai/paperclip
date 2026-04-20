import { z } from "zod";
import {
  MEMORY_BINDING_TARGET_TYPES,
  MEMORY_EXTRACTION_HARNESSES,
  MEMORY_HOOK_EXTRACTION_MODES,
  MEMORY_HOOK_KINDS,
  MEMORY_HOOK_RUN_MODES,
  MEMORY_OPERATION_STATUSES,
  MEMORY_OPERATION_TYPES,
  MEMORY_PRINCIPAL_TYPES,
  MEMORY_RETENTION_STATES,
  MEMORY_REVIEW_STATES,
  MEMORY_SCOPE_TYPES,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_SOURCE_KINDS,
} from "../constants.js";

export const memoryGovernedScopeSchema = z
  .object({
    type: z.enum(MEMORY_SCOPE_TYPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

export const memoryPrincipalRefSchema = z
  .object({
    type: z.enum(MEMORY_PRINCIPAL_TYPES),
    id: z.string().trim().min(1).max(200),
  })
  .strict();

export const memoryCitationSchema = z
  .object({
    label: z.string().trim().max(200).nullable().optional(),
    url: z.string().trim().max(1000).nullable().optional(),
    excerpt: z.string().trim().max(2000).nullable().optional(),
    sourceTitle: z.string().trim().max(300).nullable().optional(),
    sourcePath: z.string().trim().max(1000).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const memoryScopeSchema = z
  .object({
    scopeType: z.enum(MEMORY_SCOPE_TYPES).nullable().optional(),
    scopeId: z.string().trim().min(1).max(200).nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
    workspaceId: z.string().trim().min(1).max(200).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    issueId: z.string().uuid().nullable().optional(),
    runId: z.string().uuid().nullable().optional(),
    teamId: z.string().trim().min(1).max(200).nullable().optional(),
    subjectId: z.string().trim().max(200).nullable().optional(),
    allowedScopes: z.array(memoryGovernedScopeSchema).max(20).nullable().optional(),
    maxSensitivityLabel: z.enum(MEMORY_SENSITIVITY_LABELS).nullable().optional(),
  })
  .strict();

export const memorySourceRefSchema = z
  .object({
    kind: z.enum(MEMORY_SOURCE_KINDS),
    issueId: z.string().uuid().nullable().optional(),
    commentId: z.string().uuid().nullable().optional(),
    documentKey: z.string().trim().max(64).nullable().optional(),
    runId: z.string().uuid().nullable().optional(),
    activityId: z.string().uuid().nullable().optional(),
    externalRef: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const memoryProviderCapabilitiesSchema = z
  .object({
    browse: z.boolean().optional().default(false),
    correction: z.boolean().optional().default(false),
    asyncIngestion: z.boolean().optional().default(false),
    providerManagedExtraction: z.boolean().optional().default(false),
  })
  .strict();

export const memoryProviderConfigFieldOptionSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const memoryProviderConfigFieldMetadataSchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    input: z.enum(["text", "number", "boolean", "select", "path", "secret"]),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    suggestedValue: z.unknown().optional(),
    placeholder: z.string().trim().max(500).nullable().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    options: z.array(memoryProviderConfigFieldOptionSchema).max(50).optional(),
  })
  .strict();

export const memoryProviderHealthCheckSchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(120),
    status: z.enum(["ok", "warning", "error", "unknown"]),
    message: z.string().trim().max(1000).nullable().optional(),
    details: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const memoryProviderConfigPathSuggestionSchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(120),
    path: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export const memoryProviderConfigMetadataSchema = z
  .object({
    fields: z.array(memoryProviderConfigFieldMetadataSchema).max(100),
    suggestedConfig: z.record(z.unknown()),
    pathSuggestions: z.array(memoryProviderConfigPathSuggestionSchema).max(20).optional(),
    healthChecks: z.array(memoryProviderHealthCheckSchema).max(50).optional(),
  })
  .strict();

export const memoryHookPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    extractionMode: z.enum(MEMORY_HOOK_EXTRACTION_MODES).optional(),
    runMode: z.enum(MEMORY_HOOK_RUN_MODES).optional(),
    harness: z.enum(MEMORY_EXTRACTION_HARNESSES).optional(),
    sensitivityLabel: z.enum(MEMORY_SENSITIVITY_LABELS).optional(),
    reviewState: z.enum(MEMORY_REVIEW_STATES).optional(),
    retentionPolicy: z.record(z.unknown()).nullable().optional(),
    modelProvider: z.string().trim().min(1).max(128).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    config: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const memoryHookPoliciesSchema = z
  .object(Object.fromEntries(MEMORY_HOOK_KINDS.map((kind) => [kind, memoryHookPolicySchema.optional()])))
  .partial()
  .strict();

export const createMemoryBindingSchema = z
  .object({
    key: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, "Binding key must be lowercase letters, numbers, _ or -"),
    name: z.string().trim().max(200).nullable().optional(),
    providerKey: z.string().trim().min(1).max(128),
    config: z.record(z.unknown()).optional().default({}),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

export const updateMemoryBindingSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be updated");

export const setCompanyMemoryBindingSchema = z
  .object({
    bindingId: z.string().uuid(),
  })
  .strict();

export const setAgentMemoryBindingSchema = z
  .object({
    bindingId: z.string().uuid().nullable(),
  })
  .strict();

export const setProjectMemoryBindingSchema = z
  .object({
    bindingId: z.string().uuid().nullable(),
  })
  .strict();

export const memoryQuerySchema = z
  .object({
    bindingKey: z.string().trim().min(1).max(64).optional(),
    scope: memoryScopeSchema.optional().default({}),
    query: z.string().trim().min(1).max(4000),
    topK: z.number().int().positive().max(25).optional().default(5),
    intent: z.enum(["agent_preamble", "answer", "browse"]).optional().default("answer"),
    metadataFilter: z.record(z.unknown()).optional(),
  })
  .strict();

export const memoryCaptureSchema = z
  .object({
    bindingKey: z.string().trim().min(1).max(64).optional(),
    scope: memoryScopeSchema.optional().default({}),
    source: memorySourceRefSchema,
    scopeType: z.enum(MEMORY_SCOPE_TYPES).nullable().optional(),
    scopeId: z.string().trim().min(1).max(200).nullable().optional(),
    owner: memoryPrincipalRefSchema.nullable().optional(),
    sensitivityLabel: z.enum(MEMORY_SENSITIVITY_LABELS).optional().default("internal"),
    retentionPolicy: z.record(z.unknown()).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    citation: memoryCitationSchema.nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    content: z.string().trim().min(1).max(20000),
    summary: z.string().trim().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    reviewState: z.enum(MEMORY_REVIEW_STATES).optional().default("pending"),
  })
  .strict();

export const memoryForgetSchema = z
  .object({
    recordIds: z.array(z.string().uuid()).min(1).max(100),
    scope: memoryScopeSchema.optional().default({}),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const memoryRevokeSchema = z
  .object({
    selector: z
      .object({
        recordIds: z.array(z.string().uuid()).min(1).max(500).optional(),
        source: memorySourceRefSchema.optional(),
        runId: z.string().uuid().optional(),
        issueId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        workspaceId: z.string().trim().min(1).max(200).optional(),
        projectId: z.string().uuid().optional(),
        teamId: z.string().trim().min(1).max(200).optional(),
        scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
        scopeId: z.string().trim().min(1).max(200).nullable().optional(),
      })
      .strict(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine((value) => Object.keys(value.selector).length > 0, "At least one revocation selector is required");

export const memoryCorrectSchema = z
  .object({
    content: z.string().trim().min(1).max(20000),
    summary: z.string().trim().max(2000).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    reason: z.string().trim().min(1).max(1000),
    sensitivityLabel: z.enum(MEMORY_SENSITIVITY_LABELS).optional(),
    retentionPolicy: z.record(z.unknown()).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    citation: memoryCitationSchema.nullable().optional(),
  })
  .strict();

export const memoryReviewSchema = z
  .object({
    reviewState: z.enum(MEMORY_REVIEW_STATES),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export const memoryRetentionSweepSchema = z
  .object({
    now: z.coerce.date().optional(),
    bindingId: z.string().uuid().optional(),
    limit: z.number().int().positive().max(1000).optional().default(500),
  })
  .strict();

export const memoryListRecordsQuerySchema = z
  .object({
    bindingId: z.string().uuid().optional(),
    providerKey: z.string().trim().min(1).max(128).optional(),
    scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
    scopeId: z.string().trim().min(1).max(200).optional(),
    ownerType: z.enum(MEMORY_PRINCIPAL_TYPES).optional(),
    ownerId: z.string().trim().min(1).max(200).optional(),
    sensitivityLabel: z.enum(MEMORY_SENSITIVITY_LABELS).optional(),
    retentionState: z.enum(MEMORY_RETENTION_STATES).optional(),
    reviewState: z.enum(MEMORY_REVIEW_STATES).optional(),
    expiresBefore: z.coerce.date().optional(),
    agentId: z.string().uuid().optional(),
    workspaceId: z.string().trim().min(1).max(200).optional(),
    issueId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    teamId: z.string().trim().min(1).max(200).optional(),
    runId: z.string().uuid().optional(),
    sourceKind: z.enum(MEMORY_SOURCE_KINDS).optional(),
    q: z.string().trim().min(1).max(500).optional(),
    includeDeleted: z.coerce.boolean().optional().default(false),
    includeRevoked: z.coerce.boolean().optional().default(false),
    includeExpired: z.coerce.boolean().optional().default(false),
    includeSuperseded: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  })
  .strict();

export const memoryListOperationsQuerySchema = z
  .object({
    bindingId: z.string().uuid().optional(),
    operationType: z.enum(MEMORY_OPERATION_TYPES).optional(),
    status: z.enum(MEMORY_OPERATION_STATUSES).optional(),
    hookKind: z.enum(MEMORY_HOOK_KINDS).optional(),
    agentId: z.string().uuid().optional(),
    issueId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  })
  .strict();

export const memoryListExtractionJobsQuerySchema = z
  .object({
    bindingId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  })
  .strict();

export const memoryRefreshJobSchema = z
  .object({
    bindingKey: z.string().trim().min(1).max(64).optional(),
    scope: memoryScopeSchema.optional().default({}),
    sourceKinds: z
      .array(z.enum(["issue", "issue_comment", "issue_document", "run"]))
      .min(1)
      .max(4)
      .optional()
      .default(["issue", "issue_comment", "issue_document"]),
    issueIds: z.array(z.string().uuid()).max(500).optional(),
    projectId: z.string().uuid().nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
    runIds: z.array(z.string().uuid()).max(500).optional(),
    since: z.coerce.date().nullable().optional(),
    until: z.coerce.date().nullable().optional(),
    dryRun: z.boolean().optional().default(false),
    limit: z.number().int().positive().max(5000).optional().default(500),
  })
  .strict();

export const memoryBindingTargetTypeSchema = z.enum(MEMORY_BINDING_TARGET_TYPES);

export type MemoryScopeInput = z.infer<typeof memoryScopeSchema>;
export type MemoryGovernedScopeInput = z.infer<typeof memoryGovernedScopeSchema>;
export type MemoryPrincipalRefInput = z.infer<typeof memoryPrincipalRefSchema>;
export type MemoryCitationInput = z.infer<typeof memoryCitationSchema>;
export type MemorySourceRefInput = z.infer<typeof memorySourceRefSchema>;
export type MemoryHookPolicyInput = z.infer<typeof memoryHookPolicySchema>;
export type MemoryHookPoliciesInput = z.infer<typeof memoryHookPoliciesSchema>;
export type CreateMemoryBinding = z.infer<typeof createMemoryBindingSchema>;
export type UpdateMemoryBinding = z.infer<typeof updateMemoryBindingSchema>;
export type SetCompanyMemoryBinding = z.infer<typeof setCompanyMemoryBindingSchema>;
export type SetAgentMemoryBinding = z.infer<typeof setAgentMemoryBindingSchema>;
export type SetProjectMemoryBinding = z.infer<typeof setProjectMemoryBindingSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryCapture = z.infer<typeof memoryCaptureSchema>;
export type MemoryForget = z.infer<typeof memoryForgetSchema>;
export type MemoryRevoke = z.infer<typeof memoryRevokeSchema>;
export type MemoryCorrect = z.infer<typeof memoryCorrectSchema>;
export type MemoryReview = z.infer<typeof memoryReviewSchema>;
export type MemoryRetentionSweep = z.infer<typeof memoryRetentionSweepSchema>;
export type MemoryListRecordsQuery = z.infer<typeof memoryListRecordsQuerySchema>;
export type MemoryListOperationsQuery = z.infer<typeof memoryListOperationsQuerySchema>;
export type MemoryListExtractionJobsQuery = z.infer<typeof memoryListExtractionJobsQuerySchema>;
export type MemoryRefreshJob = z.infer<typeof memoryRefreshJobSchema>;
