import type { Db } from "@paperclipai/db";
import { agentHarnessType, isEnvironmentDriverSupportedForAdapter, paperclipRunnerSupportsPlatform, type AgentRunnerChoice, type AgentRunnerAvailability } from "@paperclipai/shared";
import { normalizeLegacyRunnerProvider, PAPERCLIP_RUNNER_DEFAULT_MODELS } from "@paperclipai/adapter-utils";
import { findActiveServerAdapter, hasActiveAdapterOverride, waitForExternalAdapters } from "../adapters/registry.js";
import { getDisabledAdapterTypes } from "./adapter-plugin-store.js";
import { PaperclipRunnerProviderProfileError, resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";
import { forbidden, unprocessable } from "../errors.js";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";

export type RunnerTarget = { driver: string; platform?: string; architecture?: string };
export interface AgentRunnerSelection {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown>;
  runner?: AgentRunnerChoice;
  target?: RunnerTarget;
}

export function agentRunnerAvailability(harness: string, target: RunnerTarget = { driver: "local", platform: process.platform, architecture: process.arch }): AgentRunnerAvailability {
  const disabled = new Set(getDisabledAdapterTypes());
  const supported = harness === "codex_local"
    && !disabled.has(harness) && !disabled.has("paperclip_runner")
    && !!findActiveServerAdapter(harness) && !!findActiveServerAdapter("paperclip_runner")
    && !hasActiveAdapterOverride(harness) && !hasActiveAdapterOverride("paperclip_runner")
    && isEnvironmentDriverSupportedForAdapter("paperclip_runner", target.driver)
    && (!target.platform || paperclipRunnerSupportsPlatform(harness, target.platform, target.architecture ?? ""));
  return { supportedRunners: supported ? ["paperclip", "legacy"] : ["legacy"], defaultRunner: supported ? "paperclip" : "legacy" };
}

function incompatible(fields: string[]): never {
  throw unprocessable(`Paperclip Runner cannot honor these settings: ${fields.join(", ")}. Remove them or select Legacy runner in Advanced.`, { code: "agent_runner_config_incompatible", fields });
}

/** Idempotent translation. Missing dependencies or credentials never select another runner. */
export function resolveNewAgentRunner(input: AgentRunnerSelection): { adapterType: string; adapterConfig: Record<string, unknown> } {
  const adapterType = input.adapterType ?? "process";
  let config = { ...input.adapterConfig };
  const harness = agentHarnessType(adapterType, config);
  const native = adapterType === "paperclip_runner";
  if (adapterType === "codex_local" && getDisabledAdapterTypes().includes(adapterType)) throw unprocessable("Codex is disabled on this instance. Enable its adapter or choose another harness.", { code: "agent_runner_unavailable" });
  // Explicit saved native profiles (including historical provider omission) retain execution.
  if (native && (input.runner === undefined || input.runner === "paperclip" || (harness !== "codex_local" && input.runner !== "legacy"))) return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  const availability = agentRunnerAvailability(harness, input.target);
  const choice = input.runner ?? "auto";
  const useNative = choice === "paperclip" || (choice === "auto" && availability.defaultRunner === "paperclip");
  if (!useNative) {
    if (!native && harness !== "codex_local") return { adapterType, adapterConfig: config };
    if (!native && !["codexPermissionMode", "lifecycleMode", "idleTimeoutMs"].some(key => config[key] !== undefined)) return { adapterType, adapterConfig: config };
    if (harness !== "codex_local") throw unprocessable("This native harness does not have a runner override in this release.", { code: "agent_runner_unavailable" });
    if (config.codexPermissionMode !== undefined && config.codexPermissionMode !== "never") incompatible(["codexPermissionMode"]);
    if (config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn") incompatible(["lifecycleMode"]);
    for (const key of ["provider", "codexPermissionMode", "opencodePermissionMode", "acpxPermissionMode", "lifecycleMode", "idleTimeoutMs"]) delete config[key];
    return { adapterType: "codex_local", adapterConfig: { ...config, dangerouslyBypassApprovalsAndSandbox: config.dangerouslyBypassApprovalsAndSandbox ?? true } };
  }
  if (native && harness !== "codex_local" && choice === "paperclip") return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  if (availability.defaultRunner !== "paperclip") throw unprocessable("Paperclip Runner is unavailable for this harness and environment. Select Legacy runner in Advanced.", { code: "agent_runner_unavailable" });
  if (native) return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  const unsupported = ["agentCommand", "stateDir", "warmHandleIdleMs", "extraArgs", "args", "search", "fastMode", "variant", "filesystemScope", "filesystemExtraPaths", "filesystemSandboxCommand", "networkScope", "networkAllowlist", "permissionMode", "maxTurns", "disableWebSearch", "outputInactivityTimeoutMs", "terminalResultCleanupGraceMs"]
    .filter(key => config[key] !== undefined && config[key] !== false && config[key] !== "" && config[key] !== 0 && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.command && config.command !== "codex") unsupported.push("command");
  if (config.mode && config.mode !== "persistent") unsupported.push("mode");
  if (config.engine && config.engine !== "cli" && config.engine !== "acp") unsupported.push("engine");
  if (config.nonInteractivePermissions && config.nonInteractivePermissions !== "deny") unsupported.push("nonInteractivePermissions");
  if (config.dangerouslyBypassApprovalsAndSandbox === false) unsupported.push("dangerouslyBypassApprovalsAndSandbox");
  if (config.dangerouslyBypassSandbox === false) unsupported.push("dangerouslyBypassSandbox");
  if (unsupported.length) incompatible(unsupported);
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
  for (const key of ["engine", "command", "extraArgs", "args", "agentCommand", "mode", "nonInteractivePermissions", "stateDir", "warmHandleIdleMs", "dangerouslyBypassApprovalsAndSandbox", "dangerouslyBypassSandbox", "search", "fastMode", "reasoningEffort", "effort"]) delete config[key];
  if (config.model !== undefined && typeof config.model !== "string") incompatible(["model"]);
  config = { ...config, provider: "codex", model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : PAPERCLIP_RUNNER_DEFAULT_MODELS.codex, codexPermissionMode: config.codexPermissionMode ?? "never", lifecycleMode: config.lifecycleMode ?? "per_turn", ...(effort === undefined ? {} : { modelReasoningEffort: effort }) };
  try { resolvePaperclipRunnerNativeProviderInput({ backend: "codex_app_server", adapterConfig: config }); }
  catch (error) {
    if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
    throw error;
  }
  return { adapterType: "paperclip_runner", adapterConfig: config };
}

/** Use the execution environment selected by dispatch, without starting a provider. */
export async function resolveNewAgentRunnerForCompany(db: Db, companyId: string, input: AgentRunnerSelection & { defaultEnvironmentId?: string | null }) {
  if (agentHarnessType(input.adapterType ?? "process", input.adapterConfig) !== "codex_local"
    || input.runner === "legacy" || (input.adapterType === "paperclip_runner" && (input.runner === undefined || input.runner === "paperclip"))) return resolveNewAgentRunner(input);
  const target = await resolveAgentRunnerTargetForCompany(db, companyId, input.defaultEnvironmentId);
  return resolveNewAgentRunner({ ...input, target });
}

/** Shared creation/discovery target selection; no provider turn or environment lease. */
export async function resolveAgentRunnerTargetForCompany(db: Db, companyId: string, defaultEnvironmentId?: string | null): Promise<RunnerTarget> {
  await waitForExternalAdapters();
  const { instanceSettingsService } = await import("./instance-settings.js");
  const { environmentService } = await import("./environments.js");
  const settings = await instanceSettingsService(db).get();
  const envs = environmentService(db);
  const environmentId = defaultEnvironmentId ?? settings.defaultEnvironmentId;
  let environment = environmentId ? await envs.getById(environmentId) : null;
  if (settings.experimental?.enableManagedSandboxOnly && (!environment || environment.driver === "local")) {
    environment = await envs.findManagedSandboxEnvironment(companyId);
    if (!environment) throw unprocessable("The managed sandbox is unavailable. Restore Paperclip Computer and retry.", { code: "managed_sandbox_unavailable" });
  }
  if (settings.general?.executionMode === "kubernetes") {
    environment = await envs.findKubernetesEnvironment(companyId);
    if (!environment) throw unprocessable("The required Kubernetes environment is unavailable.", { code: "kubernetes_environment_unavailable" });
  }
  if (environmentId && !environment) throw unprocessable("Environment not found.");
  if (environment) {
    const boundCompanyIds = await envs.listBoundCompanyIds(environment.id);
    if (boundCompanyIds.length > 0 && !boundCompanyIds.includes(companyId)) throw forbidden("The selected environment belongs to another company.", { code: "environment_company_mismatch" });
    if (environment.status === "archived") throw unprocessable("Environment is archived.");
    if (environment.driver === "sandbox" && environment.config?.provider === "fake") throw unprocessable("The fake sandbox provider cannot execute runs.");
  }
  const driver = environment?.driver ?? "local";
  let target: RunnerTarget = driver === "local" ? { driver, platform: process.platform, architecture: process.arch }
    : { driver }; // Sandbox platform/artifact identity is verified by selected-runtime setup; do not guess an image's architecture.
  if (driver === "ssh" && environment && agentRunnerAvailability("codex_local", target).defaultRunner === "paperclip") {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    if (parsed.driver !== "ssh") throw unprocessable("The selected SSH environment is unavailable.");
    let output: string;
    try { output = (await runSshCommand(parsed.config, "uname -s; uname -m", { timeoutMs: 10_000 })).stdout; }
    catch { throw unprocessable("Could not check the SSH host's platform. Check its connection and retry, or select Legacy runner in Advanced.", { code: "agent_runner_platform_probe_failed" }); }
    const [os = "", arch = ""] = output.trim().split(/\r?\n/);
    target = { driver, platform: os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "unknown", architecture: arch === "x86_64" ? "x64" : ["aarch64", "arm64"].includes(arch) ? "arm64" : arch };
  }
  return target;
}
