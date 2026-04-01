import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

export const HEARTBEAT_POLICY_INTERVAL_MIN_SEC = 30;
export const HEARTBEAT_POLICY_INTERVAL_MAX_SEC = 86_400;
export const HEARTBEAT_POLICY_COOLDOWN_MIN_SEC = 0;
export const HEARTBEAT_POLICY_COOLDOWN_MAX_SEC = 3_600;
export const HEARTBEAT_POLICY_MAX_CONCURRENT_MIN = 1;
export const HEARTBEAT_POLICY_MAX_CONCURRENT_MAX = 8;

export const heartbeatPresetSchema = z.enum(["economic", "balanced", "aggressive"]);
export type HeartbeatPreset = z.infer<typeof heartbeatPresetSchema>;

export type HeartbeatPresetConfig = {
  enabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
  cooldownSec: number;
  maxConcurrentRuns: number;
};

export const HEARTBEAT_PRESET_CONFIGS: Record<HeartbeatPreset, HeartbeatPresetConfig> = {
  economic: {
    enabled: true,
    intervalSec: 1800,
    wakeOnDemand: true,
    cooldownSec: 30,
    maxConcurrentRuns: 1,
  },
  balanced: {
    enabled: true,
    intervalSec: 600,
    wakeOnDemand: true,
    cooldownSec: 10,
    maxConcurrentRuns: 2,
  },
  aggressive: {
    enabled: true,
    intervalSec: 120,
    wakeOnDemand: true,
    cooldownSec: 5,
    maxConcurrentRuns: 3,
  },
};

export const heartbeatPolicySchema = z
  .object({
    preset: heartbeatPresetSchema.optional(),
    enabled: z.boolean().optional(),
    intervalSec: z.number().int().optional(),
    wakeOnDemand: z.boolean().optional(),
    cooldownSec: z.number().int().optional(),
    maxConcurrentRuns: z.number().int().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      value.intervalSec !== undefined
      && (value.intervalSec < HEARTBEAT_POLICY_INTERVAL_MIN_SEC || value.intervalSec > HEARTBEAT_POLICY_INTERVAL_MAX_SEC)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.intervalSec must be between ${HEARTBEAT_POLICY_INTERVAL_MIN_SEC} and ${HEARTBEAT_POLICY_INTERVAL_MAX_SEC}`,
        path: ["intervalSec"],
      });
    }

    if (
      value.cooldownSec !== undefined
      && (value.cooldownSec < HEARTBEAT_POLICY_COOLDOWN_MIN_SEC || value.cooldownSec > HEARTBEAT_POLICY_COOLDOWN_MAX_SEC)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.cooldownSec must be between ${HEARTBEAT_POLICY_COOLDOWN_MIN_SEC} and ${HEARTBEAT_POLICY_COOLDOWN_MAX_SEC}`,
        path: ["cooldownSec"],
      });
    }

    if (
      value.maxConcurrentRuns !== undefined
      && (value.maxConcurrentRuns < HEARTBEAT_POLICY_MAX_CONCURRENT_MIN || value.maxConcurrentRuns > HEARTBEAT_POLICY_MAX_CONCURRENT_MAX)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.maxConcurrentRuns must be between ${HEARTBEAT_POLICY_MAX_CONCURRENT_MIN} and ${HEARTBEAT_POLICY_MAX_CONCURRENT_MAX}`,
        path: ["maxConcurrentRuns"],
      });
    }

    if (
      value.enabled === true
      && value.cooldownSec !== undefined
      && value.intervalSec !== undefined
      && value.cooldownSec > value.intervalSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "heartbeat.cooldownSec cannot exceed heartbeat.intervalSec when heartbeat is enabled",
        path: ["cooldownSec"],
      });
    }

    if (value.enabled === false && value.wakeOnDemand === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one heartbeat trigger must be enabled (interval or wakeOnDemand)",
        path: ["wakeOnDemand"],
      });
    }
  });

const runtimeConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const heartbeatValue = value.heartbeat;
  if (heartbeatValue === undefined) return;
  const parsed = heartbeatPolicySchema.safeParse(heartbeatValue);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: ["heartbeat", ...issue.path],
    });
  }
});

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

const adapterConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
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

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES).optional().default("process"),
  adapterConfig: adapterConfigSchema.optional().default({}),
  runtimeConfig: runtimeConfigSchema.optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
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

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
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

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canAssignTasks: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
