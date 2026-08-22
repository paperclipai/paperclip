import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";
import { objectWithoutDefaults } from "./partial.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown());

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().guid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().guid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // The optional stored-session claim from a completed Claude login session. It
  // is the non-secret `storedSessionId`; it carries no token. The agent-create
  // transaction consumes it as the one-time stored-session claim.
  storedSessionId: z.string().min(1).max(256).optional(),
  // The optional apply-existing flag. When true, the caller binds the fixed
  // Claude OAuth token reference to the owner stored value with no new login
  // round trip. The server permits the no-claim bind only for a user actor and
  // only when that owner already has a stored value. It carries no token.
  applyStoredClaudeLogin: z.boolean().optional(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const builtInAgentProvisionSchema = z.object({
  adapterType: agentAdapterTypeSchema.optional(),
  adapterConfig: adapterConfigSchema.optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).strict();

export type BuiltInAgentProvision = z.infer<typeof builtInAgentProvisionSchema>;

export const builtInAgentEmptyMutationSchema = z.object({}).strict().default({});

export type BuiltInAgentEmptyMutation = z.infer<typeof builtInAgentEmptyMutationSchema>;

export const builtInAgentResetSchema = z.object({
  resources: z.array(z.enum(["agent", "instructions", "skill", "routine"])).optional(),
}).strict().default({});

export type BuiltInAgentReset = z.infer<typeof builtInAgentResetSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().guid().optional().nullable(),
  sourceIssueIds: z.array(z.string().guid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = objectWithoutDefaults(
  createAgentSchema.omit({ permissions: true }),
)
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().guid().optional().nullable(),
  projectIds: z.array(z.string().guid()).max(50).optional(),
  parentIssueId: z.string().guid().optional().nullable(),
  parentIssueIds: z.array(z.string().guid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().guid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const skillTestAgentKeyScopeSchema = z.object({
  kind: z.literal("skill_test"),
  issueId: z.string().guid(),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
  skillTestAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;
export type SkillTestAgentKeyScope = z.infer<typeof skillTestAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentFallbackSisterSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  primaryAgentId: z.string().uuid(),
  sisterAgentId: z.string().uuid(),
  priority: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});

export const agentFallbackSisterListSchema = z.array(agentFallbackSisterSchema);

export const ignoreActivityWindowExceptionClassSchema = z.enum([
  "permanent_portfolio_ceo_coverage",
  "window_flipped_cto",
  "approved_control_or_routine_lane",
  "market_24_7_operations",
  "custom",
]);

export const createAgentFallbackSisterSchema = z.object({
  primaryAgentId: z.string().uuid(),
  sisterAgentId: z.string().uuid(),
  priority: z.number().int().optional().default(0),
  createdBy: z.string().trim().min(1).optional(),
  // Deliberately no .default(false): the route distinguishes "caller explicitly
  // asked to revoke" from "caller never mentioned it", and a default erases that.
  retainPrimaryIgnoreActivityWindow: z.boolean().optional(),
  primaryIgnoreActivityWindowExceptionClass: ignoreActivityWindowExceptionClassSchema.optional(),
  primaryIgnoreActivityWindowExceptionReason: z.string().trim().min(1).max(280).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.retainPrimaryIgnoreActivityWindow) {
    if (value.primaryIgnoreActivityWindowExceptionClass !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "primaryIgnoreActivityWindowExceptionClass requires retainPrimaryIgnoreActivityWindow=true",
        path: ["primaryIgnoreActivityWindowExceptionClass"],
      });
    }
    if (value.primaryIgnoreActivityWindowExceptionReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "primaryIgnoreActivityWindowExceptionReason requires retainPrimaryIgnoreActivityWindow=true",
        path: ["primaryIgnoreActivityWindowExceptionReason"],
      });
    }
    return;
  }
  if (!value.primaryIgnoreActivityWindowExceptionClass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primaryIgnoreActivityWindowExceptionClass is required when retainPrimaryIgnoreActivityWindow=true",
      path: ["primaryIgnoreActivityWindowExceptionClass"],
    });
  }
  if (!value.primaryIgnoreActivityWindowExceptionReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primaryIgnoreActivityWindowExceptionReason is required when retainPrimaryIgnoreActivityWindow=true",
      path: ["primaryIgnoreActivityWindowExceptionReason"],
    });
  }
});

export type AgentFallbackSister = z.infer<typeof agentFallbackSisterSchema>;
export type CreateAgentFallbackSister = z.infer<typeof createAgentFallbackSisterSchema>;
export type IgnoreActivityWindowExceptionClass = z.infer<typeof ignoreActivityWindowExceptionClassSchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.string().trim().min(1).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const revokeAgentFallbackSisterSchema = z.object({
  primaryAgentId: z.string().uuid(),
  sisterAgentId: z.string().uuid(),
});

export type RevokeAgentFallbackSister = z.infer<typeof revokeAgentFallbackSisterSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().guid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
