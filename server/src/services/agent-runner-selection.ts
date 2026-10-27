import type { Db } from "@paperclipai/db";
import { agentHarnessType, isEnvironmentDriverSupportedForAdapter, paperclipRunnerSupportsPlatform, type AgentRunnerChoice, type AgentRunnerAvailability } from "@paperclipai/shared";
import { normalizeLegacyRunnerProvider, PAPERCLIP_RUNNER_DEFAULT_MODELS } from "@paperclipai/adapter-utils";
import { resolveClaudeModel } from "@paperclipai/adapter-claude-local";
import { findActiveServerAdapter, hasActiveAdapterOverride, waitForExternalAdapters } from "../adapters/registry.js";
import { getDisabledAdapterTypes } from "./adapter-plugin-store.js";
import { claudeRunnerUnsupportedSettings, PaperclipRunnerProviderProfileError, resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";
import { forbidden, unprocessable } from "../errors.js";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { parseEnvironmentDriverConfig, resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { localAgentRunnerTarget } from "../lib/agent-runner-platform.js";
import { normalizeClaudeRunnerOptions, type AgentConfigurationWarning } from "@paperclipai/shared";

export type RunnerTarget = {
  driver: string; platform?: string; architecture?: string; libc?: "glibc" | "musl" | "unknown"; glibcVersion?: string;
  /** A plugin environment whose driver declares Runner task execution. It runs agents only through Paperclip Runner. */
  runnerTasks?: boolean;
  warmTaskVersion?: 1;
};
export const AGENT_RUNNER_SSH_PLATFORM_COMMAND = "uname -s; uname -m; if paperclip_glibc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null) && [ -n \"$paperclip_glibc_version\" ]; then printf 'glibc\\n%s\\n' \"$paperclip_glibc_version\"; else case \"$(ldd --version 2>&1)\" in *musl*) printf 'musl\\n' ;; *) printf 'unknown\\n' ;; esac; fi";
export interface AgentRunnerSelection {
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown>;
  runner?: AgentRunnerChoice;
  target?: RunnerTarget;
  /** Server-owned inactive setup drafts may precede model selection. Never use for a hire or run. */
  setupOnly?: boolean;
  onConfigurationWarnings?: (warnings: AgentConfigurationWarning[]) => void;
}

function runnerAdaptersAvailable(harness: string, driver: string): boolean {
  const disabled = new Set(getDisabledAdapterTypes());
  return ["codex_local", "claude_local", "opencode_local", "pi_local"].includes(harness)
    && !disabled.has(harness) && !disabled.has("paperclip_runner")
    && !!findActiveServerAdapter(harness) && !!findActiveServerAdapter("paperclip_runner")
    && !hasActiveAdapterOverride(harness) && !hasActiveAdapterOverride("paperclip_runner")
    && isEnvironmentDriverSupportedForAdapter("paperclip_runner", driver);
}

export function agentRunnerAvailability(harness: string, target: RunnerTarget = localAgentRunnerTarget()): AgentRunnerAvailability {
  if (target.runnerTasks) {
    // The plugin provisions the host and launches its own pinned Runner, so
    // Core has no platform to qualify. Legacy adapters cannot run on a plugin
    // environment, so Paperclip Runner is the only choice.
    return runnerAdaptersAvailable(harness, target.driver)
      ? { supportedRunners: ["paperclip"], defaultRunner: "paperclip" }
      : { supportedRunners: ["legacy"], defaultRunner: "legacy" };
  }
  const supported = runnerAdaptersAvailable(harness, target.driver)
    && (target.driver !== "sandbox" || Boolean(target.platform && target.architecture
      && (target.platform !== "linux" || (target.libc === "glibc" && target.glibcVersion))))
    && (harness === "claude_local"
      ? !!target.platform && paperclipRunnerSupportsPlatform(harness, target.platform, target.architecture ?? "", target.libc, target.glibcVersion)
      : !target.platform || paperclipRunnerSupportsPlatform(harness, target.platform, target.architecture ?? "", target.libc, target.glibcVersion));
  const automatic = supported && !(harness === "claude_local" && target.driver === "ssh" && target.platform === "darwin");
  return { supportedRunners: supported ? ["paperclip", "legacy"] : ["legacy"], defaultRunner: automatic ? "paperclip" : "legacy" };
}

function incompatible(fields: string[]): never {
  throw unprocessable(`Paperclip Runner cannot honor these settings: ${fields.join(", ")}. Remove them or select Legacy runner in Advanced.`, { code: "agent_runner_config_incompatible", fields });
}

function resolvePiRunnerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const unsupported = ["extraArgs", "args", "modelReasoningEffort", "reasoningEffort", "effort"]
    .filter(key => config[key] !== undefined && config[key] !== "" && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.command && config.command !== "pi") unsupported.push("command");
  if (config.model !== undefined && typeof config.model !== "string") unsupported.push("model");
  if (config.stdoutLogMode !== undefined && config.stdoutLogMode !== "compact") unsupported.push("stdoutLogMode");
  const thinking = config.piThinkingLevel ?? config.thinking;
  if (thinking !== undefined && !["off", "low", "high", "max"].includes(String(thinking))) unsupported.push("thinking");
  if (config.piThinkingLevel !== undefined && config.thinking !== undefined && config.piThinkingLevel !== config.thinking) unsupported.push("thinking", "piThinkingLevel");
  if (unsupported.length) incompatible(unsupported);
  const translated = { ...config };
  for (const key of ["command", "extraArgs", "args", "thinking", "stdoutLogMode"]) delete translated[key];
  return {
    ...translated,
    provider: "acpx", acpxAgent: "pi",
    model: typeof config.model === "string" ? config.model.trim() : "",
    piThinkingLevel: thinking ?? "low",
    acpxPermissionMode: config.acpxPermissionMode ?? "approve-all",
    lifecycleMode: config.lifecycleMode ?? "per_turn",
  };
}

function resolveOpenCodeRunnerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const unsupported = ["extraArgs", "args", "variant", "modelReasoningEffort", "reasoningEffort", "effort"]
    .filter(key => config[key] !== undefined && config[key] !== "" && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.command && config.command !== "opencode") unsupported.push("command");
  // Legacy false inherits local OpenCode permission rules, which the isolated Runner cannot retain.
  if (config.dangerouslySkipPermissions !== undefined && config.dangerouslySkipPermissions !== true) unsupported.push("dangerouslySkipPermissions");
  if (config.model !== undefined && typeof config.model !== "string") unsupported.push("model");
  if (unsupported.length) incompatible(unsupported);
  const translated = { ...config };
  for (const key of ["command", "extraArgs", "args", "variant", "modelReasoningEffort", "reasoningEffort", "effort", "dangerouslySkipPermissions"]) delete translated[key];
  return {
    ...translated,
    provider: "opencode",
    model: typeof config.model === "string" ? config.model.trim() : "",
    opencodePermissionMode: config.opencodePermissionMode ?? "allow",
    lifecycleMode: config.lifecycleMode ?? "per_turn",
  };
}

function resolveClaudeRunnerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const translated = { ...config };
  const legacyPermission = [config.permissionMode, config.acpPermissionMode].find(value => typeof value === "string" && value.trim()) as string | undefined;
  if (legacyPermission !== undefined) {
    const mode = legacyPermission.trim();
    if (!["approve-all", "approve-reads", "deny-all"].includes(mode)
      || (config.acpxPermissionMode !== undefined && config.acpxPermissionMode !== mode)) incompatible(["permissionMode", "acpPermissionMode"]);
    translated.acpxPermissionMode = mode;
  }
  for (const key of ["permissionMode", "acpPermissionMode"]) {
    if (config[key] !== undefined && typeof config[key] !== "string") incompatible([key]);
    delete translated[key];
  }
  const unsupported = claudeRunnerUnsupportedSettings(translated);
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
  if (config.model !== undefined && typeof config.model !== "string") unsupported.push("model");
  if (unsupported.length) incompatible(unsupported);
  for (const key of ["engine", "command", "mode", "acpMode", "nonInteractivePermissions", "acpNonInteractivePermissions", "dangerouslySkipPermissions", "chrome", "maxTurnsPerRun", "effort", "reasoningEffort"]) delete translated[key];
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const modelEnv = { ...env };
  if (!(typeof config.model === "string" && config.model.trim())) {
    for (const key of ["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BEDROCK_BASE_URL"]) {
      const binding = env[key];
      if (binding === undefined || typeof binding === "string") continue;
      if (binding && typeof binding === "object" && "type" in binding && binding.type === "plain"
        && "value" in binding && typeof binding.value === "string") modelEnv[key] = binding.value;
      else incompatible([`env.${key}`]);
    }
  }
  const model = resolveClaudeModel(config.model, modelEnv);
  if (!model) incompatible(["model"]);
  return { ...translated, ...(effort === undefined || effort === "" ? {} : { modelReasoningEffort: effort }), provider: "acpx", acpxAgent: "claude", model, acpxPermissionMode: translated.acpxPermissionMode ?? "approve-all", lifecycleMode: config.lifecycleMode ?? "per_turn" };
}

export function resolveNewAgentRunner(input: AgentRunnerSelection): { adapterType: string; adapterConfig: Record<string, unknown> } {
  const result = resolveAgentRunner(input);
  if (result.adapterType === "paperclip_runner" && agentHarnessType(result.adapterType, result.adapterConfig) === "claude_local") {
    const normalized = normalizeClaudeRunnerOptions(input.adapterConfig ?? {});
    result.adapterConfig = normalizeClaudeRunnerOptions(result.adapterConfig).config;
    input.onConfigurationWarnings?.(normalized.warnings);
  }
  return result;
}

function resolveAgentRunner(input: AgentRunnerSelection): { adapterType: string; adapterConfig: Record<string, unknown> } {
  const adapterType = input.adapterType ?? "process";
  let config = { ...input.adapterConfig };
  const harness = agentHarnessType(adapterType, config);
  const native = adapterType === "paperclip_runner";
  if (["codex_local", "claude_local", "opencode_local", "pi_local"].includes(adapterType) && getDisabledAdapterTypes().includes(adapterType)) throw unprocessable(`${adapterType === "pi_local" ? "Pi" : adapterType === "opencode_local" ? "OpenCode" : adapterType === "claude_local" ? "Claude" : "Codex"} is disabled on this instance. Enable its adapter or choose another harness.`, { code: "agent_runner_unavailable" });
  if (native && (input.runner === undefined || input.runner === "paperclip" || (harness !== "codex_local" && input.runner !== "legacy"))) return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  const availability = agentRunnerAvailability(harness, input.target);
  const choice = input.runner ?? "auto";
  const useNative = choice === "paperclip" || (choice === "auto" && availability.defaultRunner === "paperclip");
  if (!useNative) {
    if (harness === "pi_local") {
      if (!native) return { adapterType, adapterConfig: config };
      const thinking = config.thinking ?? config.piThinkingLevel ?? "low";
      const unsupported = [
        ...(config.acpxPermissionMode !== undefined && config.acpxPermissionMode !== "approve-all" ? ["acpxPermissionMode"] : []),
        ...(config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn" ? ["lifecycleMode"] : []),
        ...(config.acpxSessionMode !== undefined ? ["acpxSessionMode"] : []),
        ...(!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(thinking)) ? [config.thinking !== undefined ? "thinking" : "piThinkingLevel"] : []),
      ];
      if (unsupported.length) throw unprocessable(`Legacy Pi cannot honor these settings: ${unsupported.join(", ")}. Keep Paperclip Runner or explicitly choose compatible settings.`, { code: "agent_runner_config_incompatible", fields: unsupported });
      for (const key of ["provider", "acpxAgent", "acpxPermissionMode", "acpxSessionMode", "piThinkingLevel", "lifecycleMode", "idleTimeoutMs"]) delete config[key];
      return { adapterType: "pi_local", adapterConfig: { ...config, thinking } };
    }
    if (harness === "opencode_local") {
      if (!native) return { adapterType, adapterConfig: config };
      if (config.opencodePermissionMode !== undefined && config.opencodePermissionMode !== "allow") incompatible(["opencodePermissionMode"]);
      if (config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn") incompatible(["lifecycleMode"]);
      for (const key of ["provider", "opencodePermissionMode", "lifecycleMode", "idleTimeoutMs"]) delete config[key];
      return { adapterType: "opencode_local", adapterConfig: { ...config, dangerouslySkipPermissions: true } };
    }
    if (harness === "claude_local") {
      if (!native) return { adapterType, adapterConfig: config };
      if (config.acpxPermissionMode !== undefined && config.acpxPermissionMode !== "approve-all") incompatible(["acpxPermissionMode"]);
      if (config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn") incompatible(["lifecycleMode"]);
      const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
      for (const key of ["provider", "acpxAgent", "acpxPermissionMode", "lifecycleMode", "idleTimeoutMs", "modelReasoningEffort", "reasoningEffort"]) delete config[key];
      if (effort !== undefined) config.effort = effort;
      return { adapterType: "claude_local", adapterConfig: { ...config, dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true } };
    }
    if (!native && harness !== "codex_local") return { adapterType, adapterConfig: config };
    if (!native && !["codexPermissionMode", "lifecycleMode", "idleTimeoutMs"].some(key => config[key] !== undefined)) return { adapterType, adapterConfig: config };
    if (harness !== "codex_local") throw unprocessable("This native harness does not have a runner override in this release.", { code: "agent_runner_unavailable" });
    if (config.codexPermissionMode !== undefined && config.codexPermissionMode !== "never") incompatible(["codexPermissionMode"]);
    if (config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn") incompatible(["lifecycleMode"]);
    for (const key of ["provider", "codexPermissionMode", "opencodePermissionMode", "acpxPermissionMode", "lifecycleMode", "idleTimeoutMs"]) delete config[key];
    return { adapterType: "codex_local", adapterConfig: { ...config, dangerouslyBypassApprovalsAndSandbox: config.dangerouslyBypassApprovalsAndSandbox ?? true } };
  }
  if (native && harness !== "codex_local" && choice === "paperclip") return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  if (!availability.supportedRunners.includes("paperclip")) throw unprocessable(input.target?.driver === "sandbox"
    ? "Paperclip Runner is unavailable for this sandbox. Choose an immutable OCI image digest and run its environment connection probe to qualify the OS, architecture and libc, or select Legacy runner in Advanced."
    : "Paperclip Runner is unavailable for this harness and environment. Select Legacy runner in Advanced.", { code: "agent_runner_unavailable" });
  if (native) return { adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  if (harness === "pi_local") {
    config = resolvePiRunnerConfig(config);
    if (input.setupOnly && !config.model) return { adapterType: "paperclip_runner", adapterConfig: config };
    if (typeof config.model !== "string" || !/^[^/\s]+\/\S+$/.test(config.model)) throw unprocessable("Pi requires an explicit provider/model. Select a model before testing or hiring.", { code: "agent_runner_config_incompatible", fields: ["model"] });
    try { resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config }); }
    catch (error) {
      if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
      throw error;
    }
    return { adapterType: "paperclip_runner", adapterConfig: config };
  }
  if (harness === "opencode_local") {
    config = resolveOpenCodeRunnerConfig(config);
    if (input.setupOnly && !config.model) return { adapterType: "paperclip_runner", adapterConfig: config };
    try { resolvePaperclipRunnerNativeProviderInput({ backend: "opencode_server", adapterConfig: config }); }
    catch (error) {
      if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
      throw error;
    }
    return { adapterType: "paperclip_runner", adapterConfig: config };
  }
  if (harness === "claude_local") {
    config = resolveClaudeRunnerConfig(config);
    try { resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config }); }
    catch (error) {
      if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
      throw error;
    }
    return { adapterType: "paperclip_runner", adapterConfig: config };
  }
  const aliasSources = new Map<string, string>();
  for (const [canonical, alias] of [
    ["agentCommand", "acpAgentCommand"], ["stateDir", "acpStateDir"],
    ["mode", "acpMode"], ["permissionMode", "acpPermissionMode"],
    ["nonInteractivePermissions", "acpNonInteractivePermissions"],
  ]) {
    if (config[alias] === undefined) continue;
    const canonicalValue = typeof config[canonical] === "string" ? config[canonical].trim() : "";
    const aliasValue = typeof config[alias] === "string" ? config[alias].trim() : "";
    if (canonicalValue || aliasValue) {
      config[canonical] = canonicalValue || aliasValue;
      if (!canonicalValue) aliasSources.set(canonical, alias);
    } else if (config[alias] !== null && typeof config[alias] !== "string") incompatible([alias]);
    else if (typeof config[canonical] === "string") delete config[canonical];
    delete config[alias];
  }
  if (config.acpWarmHandleIdleMs !== undefined) {
    if (config.warmHandleIdleMs == null && config.acpWarmHandleIdleMs != null) {
      config.warmHandleIdleMs = config.acpWarmHandleIdleMs;
      aliasSources.set("warmHandleIdleMs", "acpWarmHandleIdleMs");
    }
    delete config.acpWarmHandleIdleMs;
  }
  const unsupported = ["agentCommand", "stateDir", "warmHandleIdleMs", "extraArgs", "args", "search", "fastMode", "variant", "filesystemScope", "filesystemExtraPaths", "filesystemSandboxCommand", "networkScope", "networkAllowlist", "permissionMode", "maxTurns", "disableWebSearch", "outputInactivityTimeoutMs", "terminalResultCleanupGraceMs"]
    .filter(key => config[key] !== undefined && config[key] !== false && config[key] !== "" && config[key] !== 0 && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.command && config.command !== "codex") unsupported.push("command");
  if (config.mode && config.mode !== "persistent") unsupported.push("mode");
  if (config.engine && config.engine !== "cli" && config.engine !== "acp") unsupported.push("engine");
  if (config.nonInteractivePermissions && config.nonInteractivePermissions !== "deny") unsupported.push("nonInteractivePermissions");
  if (config.dangerouslyBypassApprovalsAndSandbox === false) unsupported.push("dangerouslyBypassApprovalsAndSandbox");
  if (config.dangerouslyBypassSandbox === false) unsupported.push("dangerouslyBypassSandbox");
  if (unsupported.length) incompatible(unsupported.map(field => aliasSources.get(field) ?? field));
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? config.env as Record<string, unknown> : {};
  const network = env.PAPERCLIP_CODEX_ACP_NETWORK_ACCESS;
  const binding = network && typeof network === "object" && !Array.isArray(network)
    ? network as Record<string, unknown> : null;
  if (config.engine !== "cli" && (network === "false"
    || (binding?.type === "plain" && binding.value === "false")
    || binding?.type === "secret_ref" || binding?.type === "user_secret_ref")) {
    incompatible(["env.PAPERCLIP_CODEX_ACP_NETWORK_ACCESS"]);
  }
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
  for (const key of ["engine", "command", "extraArgs", "args", "agentCommand", "mode", "nonInteractivePermissions", "stateDir", "warmHandleIdleMs", "dangerouslyBypassApprovalsAndSandbox", "dangerouslyBypassSandbox", "fastMode", "reasoningEffort", "effort"]) delete config[key];
  if (config.model !== undefined && typeof config.model !== "string") incompatible(["model"]);
  config = { ...config, provider: "codex", model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : PAPERCLIP_RUNNER_DEFAULT_MODELS.codex, codexPermissionMode: config.codexPermissionMode ?? "never", lifecycleMode: config.lifecycleMode ?? "per_turn", ...(effort === undefined ? {} : { modelReasoningEffort: effort }) };
  try { resolvePaperclipRunnerNativeProviderInput({ backend: "codex_app_server", adapterConfig: config }); }
  catch (error) {
    if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message, { code: error.code });
    throw error;
  }
  return { adapterType: "paperclip_runner", adapterConfig: config };
}

export async function resolveNewAgentRunnerForCompany(db: Db, companyId: string, input: AgentRunnerSelection & { defaultEnvironmentId?: string | null }) {
  if (!["codex_local", "claude_local", "opencode_local", "pi_local"].includes(agentHarnessType(input.adapterType ?? "process", input.adapterConfig))
    || input.runner === "legacy" || (input.adapterType === "paperclip_runner" && (input.runner === undefined || input.runner === "paperclip"))) return resolveNewAgentRunner(input);
  const target = await resolveAgentRunnerTargetForCompany(db, companyId, input.defaultEnvironmentId);
  return resolveNewAgentRunner({ ...input, target });
}

export async function resolveAgentRunnerTargetForCompany(db: Db, companyId: string, defaultEnvironmentId?: string | null): Promise<RunnerTarget> {
  await waitForExternalAdapters();
  const { environment, driver } = await resolveAgentRunnerEnvironmentForCompany(db, companyId, defaultEnvironmentId);
  let target: RunnerTarget = driver === "local" ? localAgentRunnerTarget()
    : { driver };
  if (driver === "plugin" && environment) {
    const taskDriver = await pluginEnvironmentRunnerTaskDriver(db, environment);
    if (taskDriver) target = { driver, runnerTasks: true, ...(taskDriver.warmTaskVersion === 1 ? { warmTaskVersion: 1 as const } : {}) };
  }
  if (driver === "sandbox" && environment) {
    const { readSandboxPlatformQualification } = await import("./environment-probe.js");
    const qualified = await readSandboxPlatformQualification(db, environment, companyId);
    if (qualified) target = { driver, ...qualified };
  }
  if (driver === "ssh" && environment && ["codex_local", "claude_local", "opencode_local", "pi_local"].some(harness => runnerAdaptersAvailable(harness, driver))) {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    if (parsed.driver !== "ssh") throw unprocessable("The selected SSH environment is unavailable.");
    let output: string;
    try { output = (await runSshCommand(parsed.config, AGENT_RUNNER_SSH_PLATFORM_COMMAND, { timeoutMs: 10_000 })).stdout; }
    catch { throw unprocessable("Could not check the SSH host's platform. Check its connection and retry, or select Legacy runner in Advanced.", { code: "agent_runner_platform_probe_failed" }); }
    const [os = "", arch = "", libc, glibcVersion] = output.trim().split(/\r?\n/);
    target = { driver, platform: os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "unknown", architecture: arch === "x86_64" ? "x64" : ["aarch64", "arm64"].includes(arch) ? "arm64" : arch, ...(os === "Linux" && libc !== undefined ? { libc: libc === "glibc" || libc === "musl" ? libc : "unknown", ...(libc === "glibc" && glibcVersion !== undefined ? { glibcVersion } : {}) } : {}) };
  }
  return target;
}

export async function resolveAgentRunnerEnvironmentForCompany(db: Db, companyId: string, defaultEnvironmentId?: string | null) {
  const resolved = await resolveAgentEnvironmentForCompany(db, companyId, defaultEnvironmentId);
  if (resolved.environment?.driver === "sandbox" && resolved.environment.config?.provider === "fake") throw unprocessable("The fake sandbox provider cannot execute runs.");
  return resolved;
}

// Hiring defaults inspect capabilities without probing or qualifying an already selected runner.
export async function resolveAgentRunnerTaskDriverForCompany(db: Db, companyId: string, defaultEnvironmentId?: string | null) {
  const { environment, driver } = await resolveAgentEnvironmentForCompany(db, companyId, defaultEnvironmentId);
  return driver === "plugin" && environment ? pluginEnvironmentRunnerTaskDriver(db, environment) : undefined;
}

async function resolveAgentEnvironmentForCompany(db: Db, companyId: string, defaultEnvironmentId?: string | null) {
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
    if (!environment) return { environment: null, driver: "sandbox" };
  }
  if (environmentId && !environment) throw unprocessable("Environment not found.");
  if (environment) {
    const boundCompanyIds = await envs.listBoundCompanyIds(environment.id);
    if (boundCompanyIds.length > 0 && !boundCompanyIds.includes(companyId)) throw forbidden("The selected environment belongs to another company.", { code: "environment_company_mismatch" });
    if (environment.status === "archived") throw unprocessable("Environment is archived.");
  }
  return { environment, driver: environment?.driver ?? "local" };
}

// The plugin's manifest declaration decides whether its environment runs
// Runner tasks. Run admission separately verifies a ready plugin and a live
// worker, so a plugin that is down still selects the Runner and fails its run.
async function pluginEnvironmentRunnerTaskDriver(db: Db, environment: Parameters<typeof parseEnvironmentDriverConfig>[0]) {
  let config: { pluginKey: string; driverKey: string };
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    if (parsed.driver !== "plugin") return undefined;
    config = parsed.config;
  } catch {
    return undefined;
  }
  const { pluginRegistryService } = await import("./plugin-registry.js");
  const plugin = await pluginRegistryService(db).getByKey(config.pluginKey);
  return plugin?.manifestJson.capabilities.includes("environment.drivers.register")
    ? plugin.manifestJson.environmentDrivers?.find(driver => driver.driverKey === config.driverKey && driver.supportsTasks === true) : undefined;
}
