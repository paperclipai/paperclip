import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
} from "@paperclipai/adapter-utils";

/**
 * The saved task session holds a provider thread. A change to its effective
 * run configuration discards that thread, so the session fingerprint must
 * cover what the thread saw or may do, and nothing else. A fingerprint input
 * that cannot change the thread discards history for no benefit.
 *
 * Each table below classifies one source of fingerprint input. A value is
 * "kept" (hashed) or "excluded" (left out), with the reason. The tests in
 * `session-fingerprint-inputs.test.ts` fail when a new field appears in a
 * source without a classification here.
 */
export type SessionFingerprintClassification =
  | { kind: "kept"; reason: string }
  | { kind: "excluded"; reason: string };

const kept = (reason: string): SessionFingerprintClassification => ({ kind: "kept", reason });
const excluded = (reason: string): SessionFingerprintClassification => ({ kind: "excluded", reason });

const LIVE_AGENT_IDENTITY =
  "Agent tools read this from the agent row at call time; the thread holds no frozen copy.";

/**
 * Every agent field that records a configuration revision. The revision row
 * itself (id, changed keys, time) is not hashed: it says that a save happened,
 * not what changed. A field that can change the thread is hashed by content.
 */
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

/**
 * Every `paperclip_runner` adapter config key in the adapter's config schema
 * and the keys the board writes for it. Keys that only one provider reads are
 * classified as kept here; `paperclipRunnerSessionAdapterConfig` drops them
 * when another provider is selected.
 */
export const PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS = {
  provider: kept("Selects the harness."),
  model: kept("Selects the model."),
  acpxAgent: kept("Selects the ACP agent."),
  acpxSessionMode: kept("Cursor session mode."),
  codexPermissionMode: kept("Codex approval policy, when Codex is the provider."),
  opencodePermissionMode: kept("OpenCode tool permissions, when OpenCode is the provider."),
  acpxPermissionMode: kept("ACP tool permissions, when ACPX is the provider."),
  search: kept("Codex web search, when Codex is the provider."),
  lifecycleMode: kept("An explicit switch to warm deliberately starts a new session."),
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
  idleTimeoutMs: excluded(
    "Warm retention window only. The native session digest carries the lifecycle policy, "
      + "and a saved session keeps the policy it started with.",
  ),
  timeoutSec: excluded("Whole-turn time limit; the executor receives it apart from the execution input."),
  graceSec: excluded("Legacy child-process kill grace; the native runner path never reads it."),
} as const satisfies Record<string, SessionFingerprintClassification>;

/**
 * Every top-level key of each environment driver's config schema. Keys under a
 * plugin's own `driverConfig` belong to the plugin and are always kept.
 */
export const ENVIRONMENT_CONFIG_SESSION_INPUTS = {
  provider: kept("Sandbox provider."),
  image: kept("Sandbox image."),
  pluginKey: kept("Environment plugin."),
  driverKey: kept("Environment plugin driver."),
  driverConfig: kept("Plugin-owned driver configuration."),
  runnerLifecycleMode: kept("An explicit switch to warm deliberately starts a new session."),
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
  runnerIdleTimeoutMs: excluded("Warm retention window only."),
  reuseLease: excluded("Lease reuse policy; lease reuse decisions already ignore it."),
  archiveOnRelease: excluded("What happens to a released sandbox; lease reuse decisions already ignore it."),
  streamRunLogs: excluded("Host log streaming during a run."),
  timeoutMs: excluded("Sandbox provider RPC timeout."),
} as const satisfies Record<string, SessionFingerprintClassification>;

/** Agent runtime config keys. Unknown keys are kept. */
export const AGENT_RUNTIME_CONFIG_SESSION_INPUTS = {
  aiConnection: kept("Provider account and credentials."),
  heartbeat: excluded("Wake scheduling, concurrency, and daily caps; none of it reaches the thread."),
} as const satisfies Record<string, SessionFingerprintClassification>;

/** The selected environment's row fields. */
export const SELECTED_ENVIRONMENT_SESSION_INPUTS = {
  id: kept("A different environment is a different machine."),
  driver: kept("Execution driver."),
  config: kept("Hashed by key, as classified in ENVIRONMENT_CONFIG_SESSION_INPUTS."),
  configRevisionAt: excluded(
    "The row's update time. It moves on status, name, and description changes; the config is hashed by content.",
  ),
} as const satisfies Record<string, SessionFingerprintClassification>;

/** The environment selection fields. */
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

/** Keys that only Codex reads; another provider ignores them. */
const CODEX_ONLY_KEYS = ["search"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitKeys(value: Record<string, unknown>, keys: Iterable<string>): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

/**
 * The runner adapter config the session fingerprint hashes. It drops excluded
 * keys and the permission and search keys of providers that are not selected.
 * An unknown provider keeps every key; that config fails before a run anyway.
 */
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

/** The agent runtime config the session fingerprint hashes. */
export function sessionAgentRuntimeConfig(runtimeConfig: unknown): unknown {
  return isRecord(runtimeConfig) ? omitKeys(runtimeConfig, RUNTIME_CONFIG_EXCLUDED_KEYS) : runtimeConfig;
}

/** The environment selection the session fingerprint hashes. */
export function sessionEnvironment(environment: unknown): unknown {
  if (!isRecord(environment)) return environment;
  const result = omitKeys(environment, ENVIRONMENT_SELECTION_EXCLUDED_KEYS);
  if (!isRecord(result.selectedEnvironment)) return result;
  const selected = omitKeys(result.selectedEnvironment, SELECTED_ENVIRONMENT_EXCLUDED_KEYS);
  if (isRecord(selected.config)) selected.config = omitKeys(selected.config, ENVIRONMENT_CONFIG_EXCLUDED_KEYS);
  return { ...result, selectedEnvironment: selected };
}
