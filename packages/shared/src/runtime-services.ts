import { z } from "zod";
import { envBindingPlainSchema, envBindingSecretRefSchema } from "./validators/secret.js";

export const RUNTIME_SERVICE_TOOL_NAMES = ["services_list", "services_start", "services_register", "services_inspect", "services_control", "services_logs", "services_update_policy"] as const;
export const RUNTIME_SERVICE_AGENT_GUIDANCE = "When developing a web app, preview, API, or persistent worker, use Paperclip service tools so its process survives this run and appears in the task properties. List existing services first, then start or reuse one in the current workspace. Declare HTTP endpoints; inspect readiness and use only verified preview URLs. File edits in the shared workspace should hot reload without restarting the agent. If the sandbox does not deliver native file events, enable polling in the dev server (Vite: server.watch.usePolling = true). Verify a real edit in the browser; a connected WebSocket alone does not prove hot reload. Use a new UUID requestId for each intended mutation and reuse exactly the same arguments after a lost response. Ordinary shell background processes are not automatically managed. If native tools are unavailable and PAPERCLIP_RUNTIME_SERVICES_CALL_URL is present, POST {name, arguments} there using the bearer token in PAPERCLIP_RUNTIME_SERVICES_TOKEN. Available names and guidance are also in PAPERCLIP_RUNTIME_SERVICES_AVAILABLE and PAPERCLIP_RUNTIME_SERVICES_GUIDANCE. Never print tokens or put them in service commands or environment bindings.";

export const RUNTIME_SERVICE_STATES = [
  "pending", "starting", "ready", "unhealthy", "sleeping", "stopping", "stopped", "failed", "deleted",
] as const;
export const RUNTIME_SERVICE_ACTIONS = ["start", "stop", "restart", "sleep", "delete"] as const;
export type RuntimeServiceState = (typeof RUNTIME_SERVICE_STATES)[number];
export type RuntimeServiceAction = (typeof RUNTIME_SERVICE_ACTIONS)[number];
export type RuntimeServiceDesiredState = "running" | "sleeping" | "stopped" | "deleted";

const boundedText = z.string().max(32_768).refine((value) => !value.includes("\0"), "NUL is not allowed");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(
  (value) => !/^(PAPERCLIP_|CODEX_HOME$|NODE_OPTIONS$|LD_|DYLD_)/i.test(value),
  "Runtime control and loader environment variables cannot be overridden",
);

export const runtimeServiceEnvironmentSchema = z.record(envName, z.union([
  envBindingPlainSchema.extend({ value: boundedText }), envBindingSecretRefSchema,
]));

export const runtimeServiceEndpointSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  port: z.number().int().min(1024).max(65535).optional(),
  // A named environment variable lets launch commands use the allocated port.
  portEnv: envName.default("PORT"),
  healthPath: z.string().max(2048).regex(/^\/(?!\/)[^\x00-\x20\\#]*$/).default("/"),
}).strict();

export const runtimeServicePolicySchema = z.object({
  idleSeconds: z.number().int().min(1).max(30 * 24 * 3600).nullable(),
  maxRunningSeconds: z.number().int().min(1).max(30 * 24 * 3600).nullable().default(null),
  keepRunningUntil: z.string().datetime().nullable().default(null),
  restartAttempts: z.number().int().min(0).max(3).default(3),
  readinessTimeoutSeconds: z.number().int().min(1).max(300).default(60),
}).strict();
export type RuntimeServicePolicy = z.infer<typeof runtimeServicePolicySchema>;
// Zod applies defaults even inside partial objects. PATCH must preserve omitted
// fields, especially holds and hard deadlines already saved by the operator.
const runtimeServicePolicyOverridesSchema = runtimeServicePolicySchema.extend({
  maxRunningSeconds: runtimeServicePolicySchema.shape.maxRunningSeconds.removeDefault(),
  keepRunningUntil: runtimeServicePolicySchema.shape.keepRunningUntil.removeDefault(),
  restartAttempts: runtimeServicePolicySchema.shape.restartAttempts.removeDefault(),
  readinessTimeoutSeconds: runtimeServicePolicySchema.shape.readinessTimeoutSeconds.removeDefault(),
}).partial();

/** Idle defaults are copied at creation; company ceilings remain live. */
export const runtimeServiceCompanyPolicyConfigSchema = z.object({
  previewIdleSeconds: z.number().int().min(1).max(30 * 24 * 3600).nullable().default(3600),
  workerIdleSeconds: z.number().int().min(1).max(30 * 24 * 3600).nullable().default(null),
  maxRunningSeconds: z.number().int().min(1).max(30 * 24 * 3600).nullable().default(null),
  maxRunningServices: z.number().int().min(1).max(10_000).nullable().default(null),
  maxServiceAllocations: z.number().int().min(1).max(10_000).nullable().default(null),
  retainedDataSeconds: z.number().int().min(86400).max(3650 * 86400).nullable().default(null),
}).strict();
export type RuntimeServiceCompanyPolicyConfig = z.infer<typeof runtimeServiceCompanyPolicyConfigSchema>;
export const updateRuntimeServiceCompanyPolicySchema = z.object({
  requestId: z.string().guid(),
  expectedRevision: z.number().int().nonnegative(),
  config: z.object({
    previewIdleSeconds: runtimeServiceCompanyPolicyConfigSchema.shape.previewIdleSeconds.removeDefault(),
    workerIdleSeconds: runtimeServiceCompanyPolicyConfigSchema.shape.workerIdleSeconds.removeDefault(),
    maxRunningSeconds: runtimeServiceCompanyPolicyConfigSchema.shape.maxRunningSeconds.removeDefault(),
    maxRunningServices: runtimeServiceCompanyPolicyConfigSchema.shape.maxRunningServices.removeDefault(),
    maxServiceAllocations: runtimeServiceCompanyPolicyConfigSchema.shape.maxServiceAllocations.removeDefault(),
    retainedDataSeconds: runtimeServiceCompanyPolicyConfigSchema.shape.retainedDataSeconds.removeDefault(),
  }).strict().partial().refine((config) => Object.keys(config).length > 0, "Choose a policy change"),
}).strict();
export type UpdateRuntimeServiceCompanyPolicy = z.infer<typeof updateRuntimeServiceCompanyPolicySchema>;
export interface RuntimeServiceCompanyPolicy {
  companyId: string;
  revision: number;
  config: RuntimeServiceCompanyPolicyConfig;
  usage: { runningServices: number; serviceAllocations: number };
  updatedAt: string | null;
}

export function effectiveRuntimeServicePolicy(policy: RuntimeServicePolicy, company: RuntimeServiceCompanyPolicyConfig): RuntimeServicePolicy {
  const ceiling = company.maxRunningSeconds;
  return { ...policy, maxRunningSeconds: ceiling === null ? policy.maxRunningSeconds : Math.min(policy.maxRunningSeconds ?? ceiling, ceiling) };
}

export const createRuntimeServiceSchema = z.object({
  requestId: z.string().guid(),
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(["preview", "worker"]).default("preview"),
  command: boundedText.pipe(z.string().trim().min(1)),
  cwd: boundedText.optional(),
  environmentId: z.string().guid().optional(),
  issueId: z.string().guid().optional(),
  endpoints: z.array(runtimeServiceEndpointSchema).max(16).default([]),
  env: runtimeServiceEnvironmentSchema.default({}),
  policy: runtimeServicePolicyOverridesSchema.default({}),
  start: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  const names = value.endpoints.map((endpoint) => endpoint.name);
  const variables = value.endpoints.map((endpoint) => endpoint.portEnv);
  const ports = value.endpoints.flatMap((endpoint) => endpoint.port === undefined ? [] : [endpoint.port]);
  if (new Set(names).size !== names.length || new Set(variables).size !== variables.length || new Set(ports).size !== ports.length) {
    ctx.addIssue({ code: "custom", path: ["endpoints"], message: "Endpoint names, ports, and port environment variables must be distinct" });
  }
  for (const variable of variables) {
    if (variable in value.env) ctx.addIssue({ code: "custom", path: ["env", variable], message: "An allocated port cannot also have an environment binding" });
  }
});
export type CreateRuntimeService = z.infer<typeof createRuntimeServiceSchema>;

export const registerRuntimeServiceSchema = createRuntimeServiceSchema.safeExtend({
  sourcePid: z.number().int().min(2).max(2_147_483_647),
  start: z.literal(true).default(true),
});
export type RegisterRuntimeService = z.infer<typeof registerRuntimeServiceSchema>;

/** Server-private handoff receipt. Never accept this from an agent or expose it in views. */
export interface RuntimeServiceProcessHandoff {
  version: 1;
  sourceRunId: string;
  phase: "pending" | "stopped" | "complete";
  receipt: Record<string, unknown>;
}


export const runtimeServiceControlSchema = z.object({
  requestId: z.string().guid(),
  expectedRevision: z.number().int().nonnegative(),
  action: z.enum(RUNTIME_SERVICE_ACTIONS),
}).strict();
export const attachRuntimeServiceTaskSchema = z.object({
  requestId: z.string().guid(),
  expectedRevision: z.number().int().nonnegative(),
  issueId: z.string().guid(),
}).strict();
export type AttachRuntimeServiceTask = z.infer<typeof attachRuntimeServiceTaskSchema>;
export const detachRuntimeServiceTaskSchema = attachRuntimeServiceTaskSchema;
export type DetachRuntimeServiceTask = z.infer<typeof detachRuntimeServiceTaskSchema>;
export const deleteRuntimeServiceDataSchema = z.object({
  requestId: z.string().guid(),
  planToken: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedAllocationId: z.string().guid(),
  confirm: z.literal(true),
}).strict();
export type DeleteRuntimeServiceData = z.infer<typeof deleteRuntimeServiceDataSchema>;
export interface RuntimeServiceDataDeletion {
  reason?: "operator" | "retention";
  policyRevision?: number;
  id: string;
  state: "pending" | "deleting" | "failed" | "deleted";
  attempts: number;
  error: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  retryAt: string | null;
}
export interface RuntimeServiceDataDeletionPlan {
  allocationId: string;
  provider: string;
  planToken: string;
  scope: "independent_allocation" | "task_workspace" | "external_workspace";
  blockers: string[];
  services: Array<{ id: string; name: string; state: RuntimeServiceState }>;
  tasks: Array<{ id: string; title: string; identifier: string | null }>;
  includesHostMirror: boolean;
  remoteSandboxes?: Array<{ provider: string; id: string; name: string; deleted: boolean }>;
  workspace?: { id: string; name: string; providerType: string; preservesBranchHistory: boolean };
  deletion: RuntimeServiceDataDeletion | null;
}
export const updateRuntimeServicePolicySchema = z.object({
  requestId: z.string().guid(),
  expectedRevision: z.number().int().nonnegative(),
  // A complete edit baseline permits lifecycle-only revision changes without
  // overwriting another operator's policy. Older callers retain strict CAS.
  expectedPolicy: runtimeServicePolicyOverridesSchema.required().optional(),
  policy: runtimeServicePolicyOverridesSchema,
}).strict();
export const updateRuntimeServiceEnvironmentSchema = z.object({
  requestId: z.string().guid(),
  expectedRevision: z.number().int().nonnegative(),
  env: runtimeServiceEnvironmentSchema,
}).strict();
export interface RuntimeServiceEnvironment {
  revision: number;
  env: z.infer<typeof runtimeServiceEnvironmentSchema>;
}
export const runtimeServiceActivitySchema = z.object({
  visible: z.boolean(),
}).strict();

export const createRuntimeServiceShareSchema = z.object({
  requestId: z.string().guid(),
  endpointName: runtimeServiceEndpointSchema.shape.name,
  expiresAt: z.string().datetime(),
}).strict();
export interface RuntimeServiceShare {
  id: string;
  endpointName: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  url: string | null;
}

export function resolveRuntimeServicePolicy(purpose: "preview" | "worker", policy: Partial<RuntimeServicePolicy> = {}): RuntimeServicePolicy {
  return runtimeServicePolicySchema.parse({ idleSeconds: purpose === "preview" ? 3600 : null, ...policy });
}

/** Persisted launch input. All location/ownership fields are resolved by the server. */
export interface RuntimeServiceLaunchSpec {
  command: string;
  cwd: string;
  env: CreateRuntimeService["env"];
  endpoints: z.infer<typeof runtimeServiceEndpointSchema>[];
}

export interface RuntimeServiceEndpoint {
  name: string;
  port: number;
  health: "ready" | "pending";
  url: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  verifiedAt: string | null;
}

export const runtimeServiceStorageUsageSchema = z.object({
  status: z.enum(["unmeasured", "ready", "unavailable"]),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  measuredAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime().nullable(),
  reason: z.enum(["not_provisioned", "compute_stopped", "unsupported", "measurement_failed"]).nullable(),
});
export type RuntimeServiceStorageUsage = z.infer<typeof runtimeServiceStorageUsageSchema>;
export interface RuntimeServiceStorageView {
  allocationId: string;
  usage: RuntimeServiceStorageUsage;
  serviceCount: number;
  services: Array<{ id: string; name: string; state: RuntimeServiceState }>;
}

export const runtimeServiceDataExpirationSchema = z.object({
  policyRevision: z.number().int().nonnegative(),
  retainedDataSeconds: z.number().int().positive().nullable(),
  state: z.enum(["disabled", "pending", "protected", "scheduled", "expired"]),
  checkedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  blockers: z.array(z.string()),
});
export type RuntimeServiceDataExpiration = z.infer<typeof runtimeServiceDataExpirationSchema>;

export interface RuntimeService {
  dataDeletion?: RuntimeServiceDataDeletion | null;
  taskWorkspace?: { issueId: string } | null;
  canAttachTaskWorkspace?: boolean;
  id: string;
  companyId: string;
  name: string;
  purpose: "preview" | "worker";
  provider: string;
  issueId: string | null;
  startedByRunId: string | null;
  createdByAgentId: string | null;
  executionWorkspaceId: string | null;
  allocationId: string;
  storageUsage?: RuntimeServiceStorageUsage;
  retention: {
    state: "pending" | "retained" | "failed" | "deleting" | "released";
    error: string | null;
    compute: "running" | "retained" | "stopped" | "unknown";
    expiration?: RuntimeServiceDataExpiration;
  };
  state: RuntimeServiceState;
  desiredState: RuntimeServiceDesiredState;
  revision: number;
  policy: RuntimeServicePolicy;
  effectivePolicy?: RuntimeServicePolicy;
  companyPolicyRevision?: number;
  companyMaxRunningSeconds?: number | null;
  handoff?: { mode: "relaunch"; phase: "pending" | "stopped" | "complete" };
  endpoints: RuntimeServiceEndpoint[];
  lastActivityAt: string;
  previewActivity?: { lastSignalAt: string | null };
  startedAt: string | null;
  stoppedAt: string | null;
  restartCount: number;
  error: string | null;
  stopReason: string | null;
  detailPath: string;
  createdAt: string;
  updatedAt: string;
}
