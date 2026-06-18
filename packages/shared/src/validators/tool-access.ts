import { z } from "zod";
import {
  TOOL_ACTION_REQUEST_STATUSES,
  TOOL_APPLICATION_STATUSES,
  TOOL_APPLICATION_TYPES,
  TOOL_AUDIT_EVENT_TYPES,
  TOOL_AUDIT_OUTCOMES,
  TOOL_CATALOG_ENTRY_KINDS,
  TOOL_CATALOG_ENTRY_STATUSES,
  TOOL_CONNECTION_HEALTH_STATUSES,
  TOOL_CONNECTION_KINDS,
  TOOL_INVOCATION_APPROVAL_STATES,
  TOOL_INVOCATION_STATUSES,
  TOOL_MCP_GATEWAY_CONTEXT_SCOPE_TYPES,
  TOOL_MCP_GATEWAY_DEFAULT_PROFILE_MODES,
  TOOL_MCP_GATEWAY_STATUSES,
  TOOL_MCP_GATEWAY_TOKEN_ACTIONS,
  TOOL_MCP_GATEWAY_TOKEN_SUBJECT_TYPES,
  TOOL_POLICY_DECISIONS,
  TOOL_POLICY_TYPES,
  TOOL_PROFILE_BINDING_TARGET_TYPES,
  TOOL_PROFILE_DEFAULT_ACTIONS,
  TOOL_PROFILE_ENTRY_EFFECTS,
  TOOL_PROFILE_ENTRY_SELECTOR_TYPES,
  TOOL_PROFILE_STATUSES,
  TOOL_RATE_LIMIT_WINDOW_KINDS,
  TOOL_RISK_LEVELS,
  TOOL_RUNTIME_KINDS,
  TOOL_RUNTIME_SLOT_STATUSES,
} from "../constants.js";
import { jsonSchemaSchema } from "./plugin.js";

export const toolApplicationTypeSchema = z.enum(TOOL_APPLICATION_TYPES);
export const toolApplicationStatusSchema = z.enum(TOOL_APPLICATION_STATUSES);
export const toolConnectionTransportSchema = z.enum(["remote_http", "local_stdio"]);
export const toolConnectionStatusSchema = z.enum(["draft", "active", "disabled", "archived"]);
export const toolCredentialPlacementSchema = z.enum(["header", "env"]);
export const toolConnectionKindSchema = z.enum(TOOL_CONNECTION_KINDS);
export const toolConnectionHealthStatusSchema = z.enum(TOOL_CONNECTION_HEALTH_STATUSES);
export const toolCatalogEntryKindSchema = z.enum(TOOL_CATALOG_ENTRY_KINDS);
export const toolCatalogEntryStatusSchema = z.enum(TOOL_CATALOG_ENTRY_STATUSES);
export const toolRiskLevelSchema = z.enum(TOOL_RISK_LEVELS);
export const toolProfileStatusSchema = z.enum(TOOL_PROFILE_STATUSES);
export const toolProfileDefaultActionSchema = z.enum(TOOL_PROFILE_DEFAULT_ACTIONS);
export const toolProfileEntrySelectorTypeSchema = z.enum(TOOL_PROFILE_ENTRY_SELECTOR_TYPES);
export const toolProfileEntryEffectSchema = z.enum(TOOL_PROFILE_ENTRY_EFFECTS);
export const toolProfileBindingTargetTypeSchema = z.enum(TOOL_PROFILE_BINDING_TARGET_TYPES);
export const toolPolicyTypeSchema = z.enum(TOOL_POLICY_TYPES);
export const toolPolicyDecisionSchema = z.enum(TOOL_POLICY_DECISIONS);
export const toolInvocationStatusSchema = z.enum(TOOL_INVOCATION_STATUSES);
export const toolInvocationApprovalStateSchema = z.enum(TOOL_INVOCATION_APPROVAL_STATES);
export const toolMcpGatewayStatusSchema = z.enum(TOOL_MCP_GATEWAY_STATUSES);
export const toolMcpGatewayDefaultProfileModeSchema = z.enum(TOOL_MCP_GATEWAY_DEFAULT_PROFILE_MODES);
export const toolMcpGatewayContextScopeTypeSchema = z.enum(TOOL_MCP_GATEWAY_CONTEXT_SCOPE_TYPES);
export const toolMcpGatewayTokenSubjectTypeSchema = z.enum(TOOL_MCP_GATEWAY_TOKEN_SUBJECT_TYPES);
export const toolMcpGatewayTokenActionSchema = z.enum(TOOL_MCP_GATEWAY_TOKEN_ACTIONS);
export const toolActionRequestStatusSchema = z.enum(TOOL_ACTION_REQUEST_STATUSES);
export const toolAuditEventTypeSchema = z.enum(TOOL_AUDIT_EVENT_TYPES);
export const toolAuditOutcomeSchema = z.enum(TOOL_AUDIT_OUTCOMES);
export const toolRuntimeKindSchema = z.enum(TOOL_RUNTIME_KINDS);
export const toolRuntimeSlotStatusSchema = z.enum(TOOL_RUNTIME_SLOT_STATUSES);
export const toolRateLimitWindowKindSchema = z.enum(TOOL_RATE_LIMIT_WINDOW_KINDS);

const safeKeyPattern = /^[a-z0-9][a-z0-9._:-]*$/i;
const sensitiveConfigKeyPattern =
  /^(access[-_]?key([-_]?id)?|api[-_]?key|authorization|bearer|client[-_]?secret|credential|credentials|jwt|password|passwd|private[-_]?key|refresh[-_]?token|secret|secret[-_]?access[-_]?key|secret[-_]?key|session[-_]?token|token)$/i;

function rejectSensitiveConfigKeys(value: unknown, ctx: z.RefinementCtx, path: Array<string | number> = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveConfigKeys(entry, ctx, [...path, index]));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveConfigKeyPattern.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `Tool access config cannot persist sensitive field: ${key}. Use credentialSecretRefs instead.`,
      });
    }
    rejectSensitiveConfigKeys(nested, ctx, [...path, key]);
  }
}

export const toolCredentialSecretRefSchema = z.object({
  secretId: z.string().uuid(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
  configPath: z.string().trim().min(1).max(200),
  required: z.boolean().optional(),
  label: z.string().trim().max(120).optional().nullable(),
});

export const mcpConnectionCredentialRefSchema = z.object({
  name: z.string().trim().min(1).max(120),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
  placement: toolCredentialPlacementSchema,
  key: z.string().trim().min(1).max(160),
  prefix: z.string().max(120).nullable().optional(),
});

export const toolTransportConfigSchema = z.record(z.string(), z.unknown()).superRefine(rejectSensitiveConfigKeys);

export const toolRedactedValueSummarySchema = z.object({
  summary: z.string().max(4000),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  sha256: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional().nullable(),
  redactedFields: z.array(z.string().trim().min(1).max(200)).default([]).optional(),
  artifactId: z.string().uuid().optional().nullable(),
});

export const createToolApplicationSchema = z.object({
  applicationKey: z.string().trim().min(1).max(160).regex(safeKeyPattern).optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional().nullable(),
  type: toolApplicationTypeSchema,
  status: toolApplicationStatusSchema.optional(),
  pluginId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolApplication = z.infer<typeof createToolApplicationSchema>;

export const updateToolApplicationSchema = createToolApplicationSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool application field is required" },
);

export type UpdateToolApplication = z.infer<typeof updateToolApplicationSchema>;

export const createToolConnectionSchema = z.object({
  applicationId: z.string().uuid().optional(),
  applicationName: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  transport: toolConnectionTransportSchema.optional(),
  status: toolConnectionStatusSchema.optional(),
  connectionKind: toolConnectionKindSchema.default("managed"),
  config: toolTransportConfigSchema.optional(),
  transportConfig: toolTransportConfigSchema.default({}),
  credentialRefs: z.array(mcpConnectionCredentialRefSchema).optional(),
  credentialSecretRefs: z.array(toolCredentialSecretRefSchema).default([]),
  enabled: z.boolean().optional(),
});

export type CreateToolConnection = z.infer<typeof createToolConnectionSchema>;

export const updateToolConnectionSchema = createToolConnectionSchema.omit({ applicationId: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool connection field is required" },
);

export type UpdateToolConnection = z.infer<typeof updateToolConnectionSchema>;

const envKeyPattern = /^[A-Z_][A-Z0-9_]*$/i;

export const toolStdioTemplateToolSchema = z.object({
  name: z.string().trim().min(1).max(240),
  title: z.string().trim().max(240).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  inputSchema: jsonSchemaSchema.optional().nullable(),
  annotations: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const createToolStdioCommandTemplateSchema = z.object({
  templateId: z.string().trim().min(1).max(160).regex(safeKeyPattern),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional().nullable(),
  command: z.string().trim().min(1).max(2000),
  args: z.array(z.string().max(2000)).max(100).default([]),
  envKeys: z.array(z.string().trim().min(1).max(160).regex(envKeyPattern)).max(200).default([]),
  tools: z.array(toolStdioTemplateToolSchema).max(500).default([]),
});

export type CreateToolStdioCommandTemplate = z.infer<typeof createToolStdioCommandTemplateSchema>;

export const disableToolStdioCommandTemplateSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
});

export type DisableToolStdioCommandTemplate = z.infer<typeof disableToolStdioCommandTemplateSchema>;

export const connectToolAppSchema = z.object({
  galleryKey: z.string().trim().min(1).max(120).optional(),
  link: z.string().trim().url().max(2000).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  credentialValues: z.record(z.string().trim().min(1).max(200), z.string().min(1)).optional(),
  configValues: z.record(z.string().trim().min(1).max(200), z.unknown()).optional(),
  applicationId: z.string().uuid().optional(),
}).refine(
  (value) => Boolean(value.galleryKey) !== Boolean(value.link),
  { message: "Provide exactly one of galleryKey or link" },
);

export type ConnectToolApp = z.infer<typeof connectToolAppSchema>;

export const reconnectToolAppSchema = z.object({
  credentialValues: z.record(z.string().trim().min(1).max(200), z.string().min(1)),
});

export type ReconnectToolApp = z.infer<typeof reconnectToolAppSchema>;

export const finishToolAppSchema = z.object({
  enabledCatalogEntryIds: z.array(z.string().uuid()).max(500).default([]),
  askFirstCatalogEntryIds: z.array(z.string().uuid()).max(500).default([]),
  access: z.union([
    z.literal("all_agents"),
    z.object({ agentIds: z.array(z.string().uuid()).min(1).max(250) }),
  ]),
});

export type FinishToolApp = z.infer<typeof finishToolAppSchema>;

export const upsertToolCatalogEntrySchema = z.object({
  applicationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  entryKind: toolCatalogEntryKindSchema.default("tool"),
  toolName: z.string().trim().min(1).max(240),
  title: z.string().trim().max(240).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  inputSchema: jsonSchemaSchema.optional().nullable(),
  outputSchema: jsonSchemaSchema.optional().nullable(),
  annotations: z.record(z.string(), z.unknown()).optional().nullable(),
  riskLevel: toolRiskLevelSchema.default("medium"),
  isReadOnly: z.boolean().default(false),
  isWrite: z.boolean().default(false),
  isDestructive: z.boolean().default(false),
  status: toolCatalogEntryStatusSchema.default("active"),
  version: z.string().trim().max(200).optional().nullable(),
  schemaHash: z.string().trim().max(128).optional().nullable(),
});

export type UpsertToolCatalogEntry = z.infer<typeof upsertToolCatalogEntrySchema>;

export const createToolProfileSchema = z.object({
  profileKey: z.string().trim().min(1).max(160).regex(safeKeyPattern),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional().nullable(),
  status: toolProfileStatusSchema.default("active"),
  defaultAction: toolProfileDefaultActionSchema.default("deny"),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolProfile = z.infer<typeof createToolProfileSchema>;

export const updateToolProfileSchema = createToolProfileSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool profile field is required" },
);

export type UpdateToolProfile = z.infer<typeof updateToolProfileSchema>;

export const createToolProfileEntrySchema = z.object({
  profileId: z.string().uuid(),
  selectorType: toolProfileEntrySelectorTypeSchema,
  effect: toolProfileEntryEffectSchema.default("include"),
  applicationId: z.string().uuid().optional().nullable(),
  connectionId: z.string().uuid().optional().nullable(),
  catalogEntryId: z.string().uuid().optional().nullable(),
  toolName: z.string().trim().min(1).max(240).optional().nullable(),
  riskLevel: toolRiskLevelSchema.optional().nullable(),
  conditions: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolProfileEntry = z.infer<typeof createToolProfileEntrySchema>;

export const createToolProfileEntryForProfileSchema = createToolProfileEntrySchema.omit({ profileId: true });

export type CreateToolProfileEntryForProfile = z.infer<typeof createToolProfileEntryForProfileSchema>;

export const updateToolProfileEntrySchema = createToolProfileEntryForProfileSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool profile entry field is required" },
);

export type UpdateToolProfileEntry = z.infer<typeof updateToolProfileEntrySchema>;

export const createToolProfileWithEntriesSchema = createToolProfileSchema.extend({
  entries: z.array(createToolProfileEntryForProfileSchema).max(250).optional(),
});

export type CreateToolProfileWithEntries = z.infer<typeof createToolProfileWithEntriesSchema>;

export const duplicateToolProfileSchema = z.object({
  name: z.string().trim().min(1).max(160),
  includeAssignments: z.boolean().default(false),
});

export type DuplicateToolProfile = z.infer<typeof duplicateToolProfileSchema>;

export const updateToolProfileWithEntriesSchema = createToolProfileSchema.partial().extend({
  entries: z.array(createToolProfileEntryForProfileSchema).max(250).optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool profile field is required" },
);

export type UpdateToolProfileWithEntries = z.infer<typeof updateToolProfileWithEntriesSchema>;

export const reviewToolProfileNewToolsSchema = z.object({
  decisions: z.array(z.object({
    catalogEntryId: z.string().uuid(),
    decision: z.enum(["allow", "keep_blocked"]),
  })).min(1).max(250),
});

export type ReviewToolProfileNewTools = z.infer<typeof reviewToolProfileNewToolsSchema>;

export const deleteToolProfileSchema = z.object({
  force: z.boolean().default(false),
  reassignToProfileId: z.string().uuid().optional(),
}).default({});

export type DeleteToolProfile = z.infer<typeof deleteToolProfileSchema>;

export const createToolProfileBindingSchema = z.object({
  profileId: z.string().uuid(),
  targetType: toolProfileBindingTargetTypeSchema,
  targetId: z.string().trim().min(1).max(200),
  priority: z.number().int().min(0).max(10000).default(100),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolProfileBinding = z.infer<typeof createToolProfileBindingSchema>;

export const createToolProfileBindingForProfileSchema = createToolProfileBindingSchema.omit({ profileId: true });

export type CreateToolProfileBindingForProfile = z.infer<typeof createToolProfileBindingForProfileSchema>;

export const unbindToolProfileBindingSchema = createToolProfileBindingForProfileSchema.pick({
  targetType: true,
  targetId: true,
});

export type UnbindToolProfileBinding = z.infer<typeof unbindToolProfileBindingSchema>;

const headerNameSchema = z.string().trim().min(1).max(120).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);

export const toolMcpGatewayAuthConfigSchema = z.object({
  version: z.literal(1).default(1),
  bearer: z.object({
    enabled: z.boolean().default(true),
    tokenPrefix: z.literal("pcgw").default("pcgw"),
    defaultTtlSeconds: z.number().int().positive().max(31_536_000).nullable().default(7_776_000),
    requireFiniteExpiry: z.boolean().default(true),
    longLivedTokenRequiresOverride: z.boolean().default(true),
  }).default({}),
  oauth: z.object({
    enabled: z.literal(false).default(false),
    reservedFor: z.literal("v1_5").default("v1_5"),
    protectedResourceMetadataPath: z.string().trim().max(240).optional().nullable(),
    dynamicClientRegistration: z.literal(false).optional(),
    authorizationCodePkce: z.literal(false).optional(),
  }).default({}),
});

export const toolMcpGatewayHeaderPolicySchema = z.object({
  version: z.literal(1).default(1),
  callerPassthrough: z.object({
    enabled: z.boolean().default(false),
    allowedHeaders: z.array(headerNameSchema).max(50).default([]),
  }).default({}),
  staticHeaders: z.array(z.object({
    name: headerNameSchema,
    valueRef: z.string().trim().max(240).optional().nullable(),
    value: z.string().max(4000).optional().nullable(),
  })).max(50).default([]),
  generatedMetadata: z.object({
    enabled: z.boolean().default(false),
    allowedHeaders: z.array(headerNameSchema).max(20).default([]),
  }).default({}),
  responseHeaders: z.object({
    forwardMcpRequiredHeaders: z.boolean().default(true),
    forwardSafeCacheHeaders: z.boolean().default(true),
  }).default({}),
});

export const toolMcpGatewayMetadataPolicySchema = z.object({
  version: z.literal(1).default(1),
  forwardCompanyId: z.boolean().default(false),
  forwardGatewayId: z.boolean().default(false),
  forwardProjectId: z.boolean().default(false),
  forwardIssueId: z.boolean().default(false),
  forwardAgentId: z.boolean().default(false),
  forwardRunId: z.boolean().default(false),
  forwardCorrelationId: z.boolean().default(true),
});

export const toolMcpGatewayOnDemandToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  searchToolName: z.literal("search_tools").default("search_tools"),
  runToolName: z.literal("run_tool").default("run_tool"),
});

export const createToolMcpGatewaySchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(120).regex(safeKeyPattern).optional(),
  displaySlug: z.string().trim().min(1).max(120).regex(safeKeyPattern).optional(),
  description: z.string().max(4000).optional().nullable(),
  profileId: z.string().uuid(),
  defaultProfileMode: toolMcpGatewayDefaultProfileModeSchema.default("gateway_only").optional(),
  contextScopeType: toolMcpGatewayContextScopeTypeSchema.default("none").optional(),
  contextScopeId: z.string().trim().min(1).max(200).optional().nullable(),
  agentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  approvalIssueId: z.string().uuid().optional().nullable(),
  authConfig: toolMcpGatewayAuthConfigSchema.optional(),
  headerPolicy: toolMcpGatewayHeaderPolicySchema.optional(),
  metadataPolicy: toolMcpGatewayMetadataPolicySchema.optional(),
  onDemandToolsConfig: toolMcpGatewayOnDemandToolsConfigSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolMcpGateway = z.infer<typeof createToolMcpGatewaySchema>;

export const updateToolMcpGatewaySchema = createToolMcpGatewaySchema
  .partial()
  .extend({ status: toolMcpGatewayStatusSchema.optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "At least one gateway field is required" });

export type UpdateToolMcpGateway = z.infer<typeof updateToolMcpGatewaySchema>;

export const createToolMcpGatewayTokenSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subjectType: toolMcpGatewayTokenSubjectTypeSchema.default("gateway_client").optional(),
  subjectId: z.string().trim().min(1).max(240).optional().nullable(),
  clientLabel: z.string().trim().min(1).max(160),
  ownerNote: z.string().trim().min(1).max(1000),
  allowedActions: z.array(toolMcpGatewayTokenActionSchema).min(1).max(TOOL_MCP_GATEWAY_TOKEN_ACTIONS.length).default(["tools/list", "tools/call"]).optional(),
  expiresAt: z.coerce.date().optional().nullable(),
  expiryOverrideReason: z.string().trim().min(1).max(1000).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.subjectType && value.subjectType !== "gateway_client") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectType"],
      message: "V1 can only mint gateway_client service tokens; board_user and agent subjects are reserved for later OAuth/user-bound flows.",
    });
  }
  if (value.expiresAt === null && !value.expiryOverrideReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiryOverrideReason"],
      message: "Non-expiring gateway tokens require an override reason.",
    });
  }
});

export type CreateToolMcpGatewayToken = z.infer<typeof createToolMcpGatewayTokenSchema>;

const argumentConditionSchema = z.object({
  fieldEquals: z.record(z.string().trim().min(1).max(120), z.unknown()).optional(),
  fieldNotEquals: z.record(z.string().trim().min(1).max(120), z.unknown()).optional(),
  fieldIn: z.record(z.string().trim().min(1).max(120), z.array(z.unknown()).min(1).max(100)).optional(),
  fieldMatches: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(500)).optional(),
  fieldExists: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  fieldAbsent: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
}).strict().refine(
  (value) => Object.values(value).some((nested) => Array.isArray(nested) ? nested.length > 0 : Boolean(nested && Object.keys(nested).length > 0)),
  { message: "Argument conditions must include at least one field predicate" },
);

const timeWindowConditionSchema = z.object({
  startAt: z.string().trim().datetime({ offset: true }).optional(),
  endAt: z.string().trim().datetime({ offset: true }).optional(),
  daysOfWeekUtc: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startHourUtc: z.number().int().min(0).max(23).optional(),
  endHourUtc: z.number().int().min(0).max(24).optional(),
}).strict().refine(
  (value) => value.startAt || value.endAt || value.daysOfWeekUtc?.length || value.startHourUtc !== undefined || value.endHourUtc !== undefined,
  { message: "timeWindow must include at least one bound" },
);

const actorConditionSchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
  actorTypes: z.array(z.enum(["agent", "user", "system", "plugin"])).max(20).optional(),
  agentId: z.string().uuid().optional(),
  agentIds: z.array(z.string().uuid()).max(100).optional(),
}).strict();

const contextConditionSchema = z.object({
  projectId: z.string().uuid().optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
  routineId: z.string().uuid().optional(),
  routineIds: z.array(z.string().uuid()).max(100).optional(),
  issueId: z.string().uuid().optional(),
  issueIds: z.array(z.string().uuid()).max(100).optional(),
  requireIssue: z.boolean().optional(),
  requireProject: z.boolean().optional(),
  requireRoutine: z.boolean().optional(),
}).strict();

const credentialScopeConditionSchema = z.object({
  applicationId: z.string().uuid().optional(),
  applicationIds: z.array(z.string().uuid()).max(100).optional(),
  connectionId: z.string().uuid().optional(),
  connectionIds: z.array(z.string().uuid()).max(100).optional(),
  catalogEntryId: z.string().uuid().optional(),
  catalogEntryIds: z.array(z.string().uuid()).max(100).optional(),
  applicationKey: z.string().trim().min(1).max(160).optional(),
  applicationKeys: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  providerType: z.string().trim().min(1).max(160).optional(),
  providerTypes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
}).strict();

export const toolPolicyConditionsSchema = z.object({
  arguments: argumentConditionSchema.optional(),
  args: argumentConditionSchema.optional(),
  actor: actorConditionSchema.optional(),
  context: contextConditionSchema.optional(),
  risk: z.object({
    levels: z.array(toolRiskLevelSchema).max(20).optional(),
    max: toolRiskLevelSchema.optional(),
    isWrite: z.boolean().optional(),
    isDestructive: z.boolean().optional(),
  }).strict().optional(),
  credentialScope: credentialScopeConditionSchema.optional(),
  trustBoundary: z.object({
    providerType: z.string().trim().min(1).max(160).optional(),
    providerTypes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
    applicationKey: z.string().trim().min(1).max(160).optional(),
    applicationKeys: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
    remoteHttpOnly: z.boolean().optional(),
    paperclipSelfOnly: z.boolean().optional(),
  }).strict().optional(),
  timeWindow: timeWindowConditionSchema.optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Tool policy conditions must include at least one supported condition group" },
);

export const createToolPolicySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional().nullable(),
  policyType: toolPolicyTypeSchema,
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  selectors: z.record(z.string(), z.unknown()).default({}),
  conditions: toolPolicyConditionsSchema.optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateToolPolicy = z.infer<typeof createToolPolicySchema>;

export const updateToolPolicySchema = createToolPolicySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one tool policy field is required" },
);

export type UpdateToolPolicy = z.infer<typeof updateToolPolicySchema>;

export const reorderToolPoliciesSchema = z.object({
  policyIds: z.array(z.string().uuid()).min(1).max(500),
});

export type ReorderToolPolicies = z.infer<typeof reorderToolPoliciesSchema>;

export const duplicateToolPolicySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
});

export type DuplicateToolPolicy = z.infer<typeof duplicateToolPolicySchema>;

export const createToolInvocationSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(300).optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  runId: z.string().uuid().optional().nullable(),
  applicationId: z.string().uuid().optional().nullable(),
  connectionId: z.string().uuid().optional().nullable(),
  catalogEntryId: z.string().uuid().optional().nullable(),
  toolName: z.string().trim().min(1).max(240),
  argumentsHash: z.string().trim().max(128).optional().nullable(),
  argumentsSummary: toolRedactedValueSummarySchema.optional().nullable(),
});

export type CreateToolInvocation = z.infer<typeof createToolInvocationSchema>;

export const createToolActionRequestSchema = z.object({
  invocationId: z.string().uuid(),
  issueId: z.string().uuid().optional().nullable(),
  canonicalArgumentsHash: z.string().trim().min(1).max(128),
  canonicalArgumentsSummary: toolRedactedValueSummarySchema,
  signedArguments: z.string().trim().max(4096).optional().nullable(),
  previewMarkdown: z.string().max(20_000).optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
});

export type CreateToolActionRequest = z.infer<typeof createToolActionRequestSchema>;

export const toolConnectionTestCallSchema = z.object({
  agentId: z.string().uuid(),
  toolName: z.string().trim().min(1).max(240),
  parameters: z.unknown().optional(),
});

export type ToolConnectionTestCallInput = z.infer<typeof toolConnectionTestCallSchema>;

export const importMcpJsonSchema = z.object({
  mcpJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

export type ImportMcpJson = z.infer<typeof importMcpJsonSchema>;

export const toolAccessSelectorSchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
  agentId: z.string().uuid().optional(),
  agentIds: z.array(z.string().uuid()).optional(),
  projectId: z.string().uuid().optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  routineId: z.string().uuid().optional(),
  routineIds: z.array(z.string().uuid()).optional(),
  issueId: z.string().uuid().optional(),
  issueIds: z.array(z.string().uuid()).optional(),
  gatewayId: z.string().uuid().optional(),
  gatewayIds: z.array(z.string().uuid()).optional(),
  gatewayPublicId: z.string().trim().min(1).max(120).regex(safeKeyPattern).optional(),
  gatewayPublicIds: z.array(z.string().trim().min(1).max(120).regex(safeKeyPattern)).optional(),
  gatewayTokenId: z.string().uuid().optional(),
  gatewayTokenIds: z.array(z.string().uuid()).optional(),
  clientSubjectType: toolMcpGatewayTokenSubjectTypeSchema.optional(),
  clientSubjectTypes: z.array(toolMcpGatewayTokenSubjectTypeSchema).optional(),
  clientName: z.string().trim().min(1).max(160).optional(),
  clientNames: z.array(z.string().trim().min(1).max(160)).optional(),
  externalClient: z.boolean().optional(),
  applicationId: z.string().uuid().optional(),
  applicationIds: z.array(z.string().uuid()).optional(),
  connectionId: z.string().uuid().optional(),
  connectionIds: z.array(z.string().uuid()).optional(),
  catalogEntryId: z.string().uuid().optional(),
  catalogEntryIds: z.array(z.string().uuid()).optional(),
  toolName: z.string().trim().min(1).max(240).optional(),
  toolNames: z.array(z.string().trim().min(1).max(240)).optional(),
  riskLevel: toolRiskLevelSchema.optional(),
  riskLevels: z.array(toolRiskLevelSchema).optional(),
});

export const toolRateLimitRuleSchema = z.object({
  limit: z.number().int().positive().max(1_000_000),
  windowSeconds: z.number().int().positive().max(31_536_000),
  keyBy: z.array(z.enum(["company", "agent", "application", "connection", "tool"])).optional(),
});

export const toolTrustRuleArgumentFiltersSchema = z.object({
  allowAny: z.boolean().optional(),
  exactHash: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional().nullable(),
  allowedHashes: z.array(z.string().trim().regex(/^[a-f0-9]{64}$/i)).max(100).optional(),
  fieldEquals: z.record(z.string().trim().min(1).max(120), z.unknown()).optional(),
  fieldNotEquals: z.record(z.string().trim().min(1).max(120), z.unknown()).optional(),
  fieldIn: z.record(z.string().trim().min(1).max(120), z.array(z.unknown()).min(1).max(100)).optional(),
  fieldMatches: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(500)).optional(),
  fieldExists: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  fieldAbsent: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
}).refine(
  (value) => value.allowAny === true
    || Boolean(value.exactHash)
    || Boolean(value.allowedHashes?.length)
    || Boolean(value.fieldEquals && Object.keys(value.fieldEquals).length > 0)
    || Boolean(value.fieldNotEquals && Object.keys(value.fieldNotEquals).length > 0)
    || Boolean(value.fieldIn && Object.keys(value.fieldIn).length > 0)
    || Boolean(value.fieldMatches && Object.keys(value.fieldMatches).length > 0)
    || Boolean(value.fieldExists?.length)
    || Boolean(value.fieldAbsent?.length),
  { message: "Trust-rule argument filters must specify allowAny, a hash filter, or a field predicate" },
);

export const toolTrustRuleScopeSchema = z.object({
  includeAgent: z.boolean().optional(),
  includeProject: z.boolean().optional(),
  includeIssue: z.boolean().optional(),
  includeApplication: z.boolean().optional(),
  includeConnection: z.boolean().optional(),
  includeCatalogEntry: z.boolean().optional(),
  includeTool: z.boolean().optional(),
});

export const toolTrustRuleBatchApprovalSchema = z.object({
  enabled: z.boolean().optional(),
  maxBatchSize: z.number().int().positive().max(100).optional(),
  windowSeconds: z.number().int().positive().max(31_536_000).optional(),
});

export const createToolTrustRuleFromActionRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(4000).optional().nullable(),
  priority: z.number().int().min(0).max(10000).default(40),
  approvalThreshold: z.number().int().min(1).max(50).default(2),
  selectors: toolAccessSelectorSchema.optional(),
  scope: toolTrustRuleScopeSchema.optional(),
  argumentFilters: toolTrustRuleArgumentFiltersSchema.optional(),
  expiresAt: z.coerce.date().optional().nullable(),
  batchApproval: toolTrustRuleBatchApprovalSchema.optional().nullable(),
});

export type CreateToolTrustRuleFromActionRequest = z.infer<typeof createToolTrustRuleFromActionRequestSchema>;

export const revokeToolTrustRuleSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
});

export type RevokeToolTrustRule = z.infer<typeof revokeToolTrustRuleSchema>;

export const toolPolicyTestRequestSchema = z.object({
  companyId: z.string().uuid(),
  actor: z.object({
    actorType: z.enum(["agent", "user", "system", "plugin"]),
    actorId: z.string().trim().min(1).max(240),
    agentId: z.string().uuid().optional().nullable(),
  }),
  runContext: z.object({
    heartbeatRunId: z.string().uuid().optional().nullable(),
    issueId: z.string().uuid().optional().nullable(),
    projectId: z.string().uuid().optional().nullable(),
    routineId: z.string().uuid().optional().nullable(),
    gatewayId: z.string().uuid().optional().nullable(),
    gatewayPublicId: z.string().trim().min(1).max(120).regex(safeKeyPattern).optional().nullable(),
    gatewayTokenId: z.string().uuid().optional().nullable(),
    clientSubjectType: toolMcpGatewayTokenSubjectTypeSchema.optional().nullable(),
    clientSubjectId: z.string().trim().min(1).max(240).optional().nullable(),
    clientName: z.string().trim().min(1).max(160).optional().nullable(),
    externalClient: z.boolean().optional().nullable(),
  }).optional().nullable(),
  request: z.object({
    applicationId: z.string().uuid().optional().nullable(),
    connectionId: z.string().uuid().optional().nullable(),
    catalogEntryId: z.string().uuid().optional().nullable(),
    toolName: z.string().trim().min(1).max(240),
    arguments: z.unknown().optional(),
    idempotencyKey: z.string().trim().min(1).max(512).optional().nullable(),
    sideEffecting: z.boolean().optional(),
  }),
  consumeRateLimit: z.boolean().optional(),
  writeAuditEvent: z.boolean().optional(),
});

export type ToolPolicyTestRequestInput = z.infer<typeof toolPolicyTestRequestSchema>;
