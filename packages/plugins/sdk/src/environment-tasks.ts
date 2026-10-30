import { z } from "zod";
import type { PluginEnvironmentDriverBaseParams, PluginEnvironmentLease } from "./protocol.js";

export const MAX_ENVIRONMENT_TASK_FILE_BYTES = 10 * 1024 * 1024;
const taskFilePath = z.string().min(1).max(2000).refine(value =>
  !/[\\\u0000-\u001f\u007f]/u.test(value) && !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
  value.replace(/^\//u, "").split("/").every(part => part !== "" && part !== "." && part !== ".."), "Expected a canonical task file path");
// Provider IDs are opaque; providers validate their own addressing constraints.
const providerId = z.string().min(1);
// PRP identity.schema.json stableId.
const runnerIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const durableIdentity = z.object({ runnerInstanceId: runnerIdentity, environmentLeaseId: runnerIdentity,
  runId: runnerIdentity, normalizedSessionId: runnerIdentity, turnId: runnerIdentity, itemId: runnerIdentity }).strict();
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const secureUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
}, "Expected a credential-free WSS URL");

const credentialValue = z.string().min(1).max(65_536).refine(value => !value.includes("\0"));
const githubBroker = z.object({ url: z.string().url().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Expected a credential-free HTTP broker URL"), token: credentialValue }).strict();
/** Only provider authentication is transferred. Paths and executable settings remain provider-owned. */
export const environmentTaskCredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex-auth-json"), authJson: credentialValue }).strict(),
  z.object({ type: z.literal("claude-env"), environment: z.object({
    CLAUDE_CODE_OAUTH_TOKEN: credentialValue.optional(), ANTHROPIC_API_KEY: credentialValue.optional(),
  }).strict().refine(env => Object.values(env).filter(Boolean).length === 1, "Select one Claude credential") }).strict(),
]);
export type PluginEnvironmentTaskCredential = z.infer<typeof environmentTaskCredentialSchema>;

/** Runner owns this versioned data contract. The plugin resolves its execution-host locations. */
export const environmentRunnerLaunchRequirementsSchema = z.object({
  schema: z.literal("paperclip.runner.launch-requirements.v1"),
  identity: durableIdentity,
  provider: z.enum(["codex", "opencode", "acpx", "claude_managed", "aws_agentcore"]),
  model: z.string().min(1).nullable(), instructions: z.string().max(1024 * 1024),
  runtimeContext: z.record(z.string(), z.unknown()).nullable(),
  settings: z.object({ acpxAgent: identifier.optional(), acpxMode: z.string().optional(),
    acpxPermissionMode: z.enum(["approve-all", "approve-paperclip", "approve-reads", "deny-all"]).optional(),
    acpxPermissionModePinned: z.boolean().optional(), piThinkingLevel: z.enum(["off", "low", "high", "max"]).optional(),
    claudeEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    opencodePermissionMode: z.enum(["allow", "ask", "deny"]).optional(),
    disableCodexWebSearch: z.literal(true).optional(),
    disableCodexProjectInstructions: z.literal(true).optional(),
    managedProfile: z.record(z.string(), z.unknown()).optional(), agentCoreProfile: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  approvalPolicy: z.enum(["never", "on-request", "untrusted"]), readOnly: z.boolean(),
  preparedConversation: z.boolean(), includeCollaborationModeInstructions: z.boolean(),
}).strict();
const preparedLaunch = z.object({ configurationId: providerId.max(1024),
  requirementsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  provider: z.record(z.string(), z.unknown()),
}).strict();

/** One plugin-provided Runner execution attempt with a PRP connection. Secrets are transient RPC input. */
export const environmentTaskOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("describe") }).strict(),
  z.object({ kind: z.literal("copilot_metadata"), token: credentialValue, model: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ kind: z.literal("prepare"), requirements: environmentRunnerLaunchRequirementsSchema,
    githubBroker: githubBroker.optional(),
    recovery: preparedLaunch.optional(), resumeFrom: providerId.optional(),
    priorIdentity: durableIdentity.optional(), accountIdentity: z.string().min(1).max(1024).optional(),
    projectIds: z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs"),
  }).strict(),
  z.object({
    kind: z.literal("submit"),
    projectIds: z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs"),
    runner: z.object({
      /** Inclusive PRP version range supported by the submitting client. */
      protocolMin: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      protocolMax: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      harness: identifier,
      runnerId: runnerIdentity, leaseId: runnerIdentity, runId: runnerIdentity,
      sessionId: runnerIdentity, turnId: runnerIdentity, itemId: runnerIdentity,
    }).strict().refine(value => value.protocolMin <= value.protocolMax, "Invalid PRP version range"),
    bootstrapTicket: z.string().min(1).max(65_536),
    /** Opaque prior provider task; Core authorizes the saved session before supplying it. */
    resumeFrom: z.string().min(1).optional(),
    preparedLaunchId: providerId.max(1024).optional(),
    /** Require the externally installed account to match this Core-selected credential revision. */
    credentialIdentity: z.string().min(1).max(1024).optional(),
    /** Stable account selection; distinct from its current credential revision. */
    accountIdentity: z.string().min(1).max(1024).optional(),
    credential: environmentTaskCredentialSchema.optional(),
    /** Core supplies these protected launch inputs for native agent runs. */
    launch: z.object({
      runnerVersion: z.string().min(1), runnerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      maxOutboxBytes: z.number().int().positive(), p0ReserveBytes: z.number().int().positive(),
      maxRuntimeMs: z.number().int().nonnegative().optional(), maxLifetimeMs: z.number().int().nonnegative().optional(),
      reconnectGraceMs: z.number().int().nonnegative().optional(),
      lifecyclePolicy: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("per_turn"), idleTimeoutMs: z.null() }).strict(),
        z.object({ mode: z.literal("warm"), idleTimeoutMs: z.number().int().positive().max(86_400_000) }).strict(),
      ]),
    }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal("check_project_auth"), configurationId: providerId.max(1024),
    provider: identifier, projectIds: z.array(z.string().uuid()).max(64)
      .refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs") }).strict(),
  z.object({ kind: z.literal("read_file"), identity: durableIdentity,
    path: taskFilePath, maxBytes: z.number().int().positive().max(MAX_ENVIRONMENT_TASK_FILE_BYTES),
    projectIds: z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs"),
  }).strict(),
  z.object({ kind: z.literal("read_state"), identity: durableIdentity, resumeFrom: providerId.optional() }).strict(),
  z.object({ kind: z.literal("archive_state"), priorIdentity: durableIdentity,
    archiveKey: z.string().regex(/^[a-f0-9]{24}$/), resumeFrom: providerId }).strict(),
  z.object({ kind: z.literal("credentials"), accountIdentity: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);

export const environmentTaskResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), taskId: providerId }).strict(),
  z.object({ kind: z.literal("copilot_metadata"), taskId: providerId, metadata: z.record(z.string(), z.unknown()),
    executionStopped: z.literal(true) }).strict(),
  z.object({ kind: z.literal("project_auth"), taskId: providerId, configurationId: providerId.max(1024),
    provider: identifier, allowed: z.boolean() }).strict(),
  z.object({ kind: z.literal("file"), taskId: providerId,
    base64: z.string().max(4 * Math.ceil(MAX_ENVIRONMENT_TASK_FILE_BYTES / 3)),
    byteSize: z.number().int().nonnegative().max(MAX_ENVIRONMENT_TASK_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({ kind: z.literal("state"), taskId: providerId, state: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("prepared"), taskId: providerId, launch: preparedLaunch, projectAuthCheckAtSubmit: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal("credentials"), taskId: providerId, /** Null proves that cancellation fenced admission before the task could start. It must not mean an unavailable export. */
    credential: environmentTaskCredentialSchema.nullable() }).strict(),
  z.object({ kind: z.literal("description"), taskId: providerId,
    runner: z.object({ version: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
    warmTaskVersion: z.literal(1).optional(),
    launchPreparationVersion: z.literal(1).optional(),
    freshWorkspaceVersion: z.literal(1).optional(),
    projectAuthCheckVersion: z.literal(1).optional(),
    workspaceFileReadVersion: z.literal(1).optional(),
    githubCredentialBrokerVersion: z.literal(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal("status"), taskId: providerId,
    phase: z.enum(["preparing", "running", "completed", "failed", "cancelled", "interrupted"]),
    exitCode: z.number().int().optional(),
    /** Provider observed the task and all descendants stopped; terminal phase alone is insufficient. */
    executionStopped: z.boolean().optional(),
    /** The provider retains this task's recoverable session state for a later launch. */
    sessionStateAvailable: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("connection"), taskId: providerId,
    endpoint: z.object({
      kind: z.literal("authenticated_websocket"), websocketUrl: secureUrl,
      generation: providerId,
      secretHeaders: z.array(z.object({
        name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        value: z.string().min(1).max(65_536).regex(/^[^\r\n]+$/),
      }).strict()).max(16),
    }).strict(),
  }).strict(),
]);

export type PluginEnvironmentRunnerLaunchRequirements = z.infer<typeof environmentRunnerLaunchRequirementsSchema>;
export type PluginEnvironmentPreparedLaunch = z.infer<typeof preparedLaunch>;

export type PluginEnvironmentTaskOperation = z.infer<typeof environmentTaskOperationSchema>;
export type PluginEnvironmentTaskResult = z.infer<typeof environmentTaskResultSchema>;

export interface PluginEnvironmentTaskParams extends Omit<PluginEnvironmentDriverBaseParams, "environmentId"> {
  /** Null during cleanup after the environment is deleted. */
  environmentId: string | null;
  lease: PluginEnvironmentLease;
  /** Provider-issued task identifier persisted in the lease, stable across ambiguous submission retries. */
  taskId: string;
  /** Null during cleanup after the associated run is deleted. */
  runId: string | null;
  agentId: string | null;
  /** Company-validated projects to prepare on submit; empty during cleanup. */
  projectIds: string[];
  workspace?: import("@paperclipai/shared").WorkspaceProviderBinding;
  fresh?: import("./workspace-provider.js").PluginFreshWorkspace;
  operation: PluginEnvironmentTaskOperation;
}

/** An accepted stop is not proof of process termination. */
export function parseEnvironmentTaskResult(operation: PluginEnvironmentTaskOperation, taskId: string, value: unknown): PluginEnvironmentTaskResult {
  const result = environmentTaskResultSchema.parse(value);
  const expected = operation.kind === "read_file" ? "file" : operation.kind === "describe" ? "description" : operation.kind === "prepare" ? "prepared" : operation.kind === "check_project_auth" ? "project_auth" : ["read_state", "archive_state"].includes(operation.kind) ? "state" : ["status", "connection", "credentials", "copilot_metadata"].includes(operation.kind) ? operation.kind : "accepted";
  if (result.taskId !== taskId || result.kind !== expected) throw new Error("Invalid plugin-provided Runner execution response");
  return result;
}
