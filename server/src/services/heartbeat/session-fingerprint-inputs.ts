import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
} from "@paperclipai/adapter-utils";

export type SessionFingerprintClassification =
  | { kind: "kept"; reason: string }
  | { kind: "excluded"; reason: string };

const kept = (reason: string): SessionFingerprintClassification => ({ kind: "kept", reason });
const excluded = (reason: string): SessionFingerprintClassification => ({ kind: "excluded", reason });

const LIVE_AGENT_IDENTITY =
  "Agent tools read this from the agent row at call time; the thread holds no frozen copy, and the native execution input does not carry it.";
const NATIVE_LIFECYCLE =
  "Becomes part of session.lifecyclePolicy. The native session digest compares that policy before a follow-up turn attaches to its warm Runner, so a change needs a new session.";

export const AGENT_REVISION_FIELD_SESSION_INPUTS = {
  adapterType: kept("Hashed as adapter.adapterType."),
  adapterConfig: kept("Hashed by content as adapterConfig."),
  runtimeConfig: kept("Hashed by content as agentRuntimeConfig."),
  defaultEnvironmentId: kept("Resolves to environment.selectedEnvironmentId, which is hashed."),
  name: excluded(LIVE_AGENT_IDENTITY),
  role: excluded(`${LIVE_AGENT_IDENTITY} Permission checks also read it per request.`),
  title: excluded(LIVE_AGENT_IDENTITY),
  capabilities: excluded(LIVE_AGENT_IDENTITY),
  reportsTo: excluded(LIVE_AGENT_IDENTITY),
  icon: excluded("Board display only."),
  appearance: excluded("Board display only."),
  budgetMonthlyCents: excluded("Budget admission runs before a run starts; it is not run input."),
  metadata: excluded("No run preparation or native execution path reads agent metadata."),
} as const satisfies Record<string, SessionFingerprintClassification>;

export const PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS = {
  provider: kept("Selects the harness."),
  model: kept("Selects the model."),
  acpxAgent: kept("Selects the ACP agent."),
  acpxSessionMode: kept("Cursor session mode."),
  codexPermissionMode: kept("Codex approval policy, when Codex is the provider; dropped for another provider."),
  opencodePermissionMode: kept("OpenCode tool permissions, when OpenCode is the provider; dropped for another provider."),
  acpxPermissionMode: kept("ACP tool permissions, when ACPX is the provider; dropped for another provider."),
  search: kept("Codex web search, when Codex is the provider; dropped for another provider."),
  lifecycleMode: kept(`${NATIVE_LIFECYCLE} An explicit switch to warm also deliberately starts a new session.`),
  idleTimeoutMs: kept(NATIVE_LIFECYCLE),
  managedProfileId: kept("Managed agent profile."),
  managedAgentsRetentionAcknowledged: kept("Managed agent retention terms."),
  maxSessionListCostUsd: kept("Managed agent spend ceiling."),
  agentCoreProfileId: kept("AgentCore profile."),
  agentCoreRetentionAcknowledged: kept("AgentCore retention terms."),
  maxEstimatedSessionCostUsd: kept("AgentCore spend ceiling."),
  maxIterations: kept("AgentCore invocation limit."),
  maxOutputTokens: kept("AgentCore invocation limit."),
  timeoutSeconds: kept("AgentCore invocation limit."),
  repoUrl: kept("Cursor Cloud repository."),
  repoRef: kept("Cursor Cloud repository ref."),
  prUrl: kept("Cursor Cloud pull request."),
  cloudEnvName: kept("Cursor Cloud environment."),
  workOnCurrentBranch: kept("Cursor Cloud branch policy."),
  autoCreatePR: kept("Cursor Cloud pull request policy."),
  skipReviewerRequest: kept("Cursor Cloud review policy."),
  cwd: kept("Workspace location."),
  instructionsFilePath: kept("Instructions; replaced by a content hash for managed bundles."),
  env: kept("Process environment and secret bindings."),
  workspaceStrategy: kept("Workspace strategy."),
  workspaceRuntime: kept("Workspace runtime services."),
  timeoutSec: excluded("Whole-turn time limit; the executor receives it apart from the native execution input."),
  graceSec: excluded("Legacy child-process kill grace; the native runner path never reads it."),
} as const satisfies Record<string, SessionFingerprintClassification>;

export const ENVIRONMENT_CONFIG_SESSION_INPUTS = {
  provider: kept("Sandbox provider."),
  image: kept("Sandbox image."),
  pluginKey: kept("Environment plugin."),
  driverKey: kept("Environment plugin driver."),
  driverConfig: kept("Plugin-owned driver configuration; every key under it is kept."),
  runnerLifecycleMode: kept(`${NATIVE_LIFECYCLE} An explicit switch to warm also deliberately starts a new session.`),
  runnerIdleTimeoutMs: kept(NATIVE_LIFECYCLE),
  reuseLease: kept(`Decides whether a remote sandbox run defaults to warm. ${NATIVE_LIFECYCLE}`),
  useHostAuth: kept("SSH authentication."),
  tailscaleConnectionId: kept("SSH network path."),
  tailscaleDeviceId: kept("SSH target machine."),
  network: kept("SSH network path."),
  tailscaleAuthKey: kept("SSH network credential."),
  tailscaleAuthKeySecretRef: kept("SSH network credential."),
  host: kept("SSH target machine."),
  port: kept("SSH target machine."),
  username: kept("SSH account."),
  remoteWorkspacePath: kept("SSH workspace location."),
  privateKey: kept("SSH credential."),
  privateKeySecretRef: kept("SSH credential."),
  knownHosts: kept("SSH host identity."),
  strictHostKeyChecking: kept("SSH host identity policy."),
  archiveOnRelease: excluded("What happens to a released sandbox; lease reuse decisions already ignore it."),
  streamRunLogs: excluded("Host log streaming during a run."),
  timeoutMs: excluded("Sandbox provider RPC timeout."),
} as const satisfies Record<string, SessionFingerprintClassification>;

export const AGENT_RUNTIME_CONFIG_SESSION_INPUTS = {
  aiConnection: kept("Provider account and credentials."),
  heartbeat: excluded("Wake scheduling, concurrency, daily caps, and max-turn continuation; none of it reaches the thread or the native execution input."),
} as const satisfies Record<string, SessionFingerprintClassification>;

export const SELECTED_ENVIRONMENT_SESSION_INPUTS = {
  id: kept("A different environment is a different machine."),
  driver: kept("Execution driver."),
  config: kept("Hashed by key, as classified in ENVIRONMENT_CONFIG_SESSION_INPUTS."),
  configRevisionAt: excluded(
    "The row's update time. It moves on status, name, and description changes; the config is hashed by content.",
  ),
} as const satisfies Record<string, SessionFingerprintClassification>;

export const ENVIRONMENT_SELECTION_SESSION_INPUTS = {
  selectedEnvironmentId: kept("A different environment is a different machine."),
  selectedEnvironment: kept("Hashed by field, as classified in SELECTED_ENVIRONMENT_SESSION_INPUTS."),
  executionPolicy: kept("Execution policy."),
  selectionSource: excluded("Records how the environment was chosen; nothing reads it to run."),
} as const satisfies Record<string, SessionFingerprintClassification>;

function excludedKeys(table: Record<string, SessionFingerprintClassification>): Set<string> {
  return new Set(Object.entries(table).filter(([, value]) => value.kind === "excluded").map(([key]) => key));
}

const RUNNER_EXCLUDED_KEYS = excludedKeys(PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS);
const ENVIRONMENT_CONFIG_EXCLUDED_KEYS = excludedKeys(ENVIRONMENT_CONFIG_SESSION_INPUTS);
const RUNTIME_CONFIG_EXCLUDED_KEYS = excludedKeys(AGENT_RUNTIME_CONFIG_SESSION_INPUTS);
const SELECTED_ENVIRONMENT_EXCLUDED_KEYS = excludedKeys(SELECTED_ENVIRONMENT_SESSION_INPUTS);
const ENVIRONMENT_SELECTION_EXCLUDED_KEYS = excludedKeys(ENVIRONMENT_SELECTION_SESSION_INPUTS);
const CODEX_ONLY_KEYS = ["search"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitKeys(value: Record<string, unknown>, keys: Iterable<string>): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

export function paperclipRunnerSessionAdapterConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = omitKeys(config, RUNNER_EXCLUDED_KEYS);
  const provider = config.provider ?? "codex";
  if (!isPaperclipRunnerProvider(provider)) return result;
  const active = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  const activeKey = active.configurable ? active.configKey : null;
  const inactivePermissionKeys = Object.values(PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES)
    .flatMap(capability => capability.configurable ? [capability.configKey] : [])
    .filter(key => key !== activeKey);
  return omitKeys(result, [...inactivePermissionKeys, ...(provider === "codex" ? [] : CODEX_ONLY_KEYS)]);
}

export function sessionAgentRuntimeConfig(runtimeConfig: unknown): unknown {
  return isRecord(runtimeConfig) ? omitKeys(runtimeConfig, RUNTIME_CONFIG_EXCLUDED_KEYS) : runtimeConfig;
}

export function sessionEnvironment(environment: unknown): unknown {
  if (!isRecord(environment)) return environment;
  const result = omitKeys(environment, ENVIRONMENT_SELECTION_EXCLUDED_KEYS);
  if (!isRecord(result.selectedEnvironment)) return result;
  const selected = omitKeys(result.selectedEnvironment, SELECTED_ENVIRONMENT_EXCLUDED_KEYS);
  if (isRecord(selected.config)) selected.config = omitKeys(selected.config, ENVIRONMENT_CONFIG_EXCLUDED_KEYS);
  return { ...result, selectedEnvironment: selected };
}
