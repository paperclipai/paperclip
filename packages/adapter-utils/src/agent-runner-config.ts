import { agentHarnessType, paperclipRunnerProfileForHarness, type AgentRunnerChoice } from "@paperclipai/shared";
import { PAPERCLIP_RUNNER_DEFAULT_MODELS, PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES, normalizeLegacyRunnerProvider } from "./paperclip-runner-permissions.js";

export class AgentRunnerConfigError extends Error {
  readonly code = "agent_runner_config_incompatible";
  constructor(message: string, readonly fields: string[] = []) { super(message); }
}

/** Pure, browser-safe translation. Availability and authorization belong to the server. */
export function resolveAgentRunnerConfig(input: {
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  runner?: AgentRunnerChoice;
  nativeSupported?: boolean;
}): { adapterType: string; adapterConfig: Record<string, unknown> } {
  const config = { ...input.adapterConfig };
  const harness = agentHarnessType(input.adapterType, config);
  const profile = paperclipRunnerProfileForHarness(harness);
  const choice = input.runner ?? "auto";
  const native = choice === "paperclip" || (choice === "auto" && (input.adapterType === "paperclip_runner"
    ? !profile || input.runner !== "auto" || input.nativeSupported !== false
    : profile && input.nativeSupported !== false));
  if (!native) {
    if (input.adapterType !== "paperclip_runner") return { adapterType: input.adapterType, adapterConfig: config };
    if (!profile) throw new AgentRunnerConfigError("This harness has no legacy runner.");
    const permission = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[profile.provider as keyof typeof PAPERCLIP_RUNNER_DEFAULT_MODELS];
    if (config[permission.configKey] !== undefined && config[permission.configKey] !== permission.defaultMode) {
      throw new AgentRunnerConfigError(`Legacy runner cannot honor ${permission.configKey}. Choose compatible permissions before changing runners.`, [permission.configKey]);
    }
    if (harness === "codex_local") config.dangerouslyBypassApprovalsAndSandbox = true;
    if (harness === "claude_local") config.dangerouslySkipPermissions = true;
    if (harness === "cursor" && config.acpxSessionMode) config.mode = config.acpxSessionMode;
    for (const key of ["provider", "acpxAgent", "codexPermissionMode", "opencodePermissionMode", "acpxPermissionMode", "acpxSessionMode", "lifecycleMode", "idleTimeoutMs"]) delete config[key];
    return { adapterType: harness, adapterConfig: config };
  }
  if (input.adapterType === "paperclip_runner") return { adapterType: input.adapterType, adapterConfig: normalizeLegacyRunnerProvider(config) };
  if (!profile || input.nativeSupported === false) throw new AgentRunnerConfigError("Paperclip Runner is unavailable for this harness. Select the legacy runner.");

  const unsupported = ["agentCommand", "stateDir", "warmHandleIdleMs", "extraArgs", "args", "chrome", "search", "fastMode", "effort", "reasoningEffort", "variant", "filesystemScope", "filesystemExtraPaths", "filesystemSandboxCommand", "networkScope", "networkAllowlist", "permissionMode", "maxTurns", "disableWebSearch", "outputInactivityTimeoutMs", "terminalResultCleanupGraceMs"]
    .filter(key => config[key] !== undefined && config[key] !== false && config[key] !== "" && config[key] !== 0 && !(Array.isArray(config[key]) && config[key].length === 0));
  const command = { codex_local: "codex", claude_local: "claude", opencode_local: "opencode", grok_local: "grok", cursor: "agent" }[harness];
  if (config.command && config.command !== command) unsupported.push("command");
  if (harness === "cursor" && ["agent", "plan", "ask"].includes(String(config.mode))) config.acpxSessionMode = config.mode;
  else if (config.mode && config.mode !== "persistent") unsupported.push("mode");
  if (config.engine && config.engine !== "cli" && config.engine !== "acp") unsupported.push("engine");
  if (config.nonInteractivePermissions && config.nonInteractivePermissions !== "deny") unsupported.push("nonInteractivePermissions");
  if (config.maxTurnsPerRun !== undefined && config.maxTurnsPerRun !== 1000 && config.maxTurnsPerRun !== 0) unsupported.push("maxTurnsPerRun");
  if (config.dangerouslySkipPermissions === false) unsupported.push("dangerouslySkipPermissions");
  if (config.dangerouslyBypassApprovalsAndSandbox === false) unsupported.push("dangerouslyBypassApprovalsAndSandbox");
  if (config.alwaysApprove === false) unsupported.push("alwaysApprove");
  if (unsupported.length) throw new AgentRunnerConfigError(`Paperclip Runner cannot honor these settings: ${unsupported.join(", ")}. Remove them or select the legacy runner.`, unsupported);
  for (const key of ["engine", "command", "extraArgs", "agentCommand", "mode", "nonInteractivePermissions", "stateDir", "warmHandleIdleMs", "dangerouslySkipPermissions", "dangerouslyBypassApprovalsAndSandbox", "maxTurnsPerRun", "chrome", "search", "fastMode", "effort", "reasoningEffort", "variant"]) delete config[key];
  const provider = profile.provider as keyof typeof PAPERCLIP_RUNNER_DEFAULT_MODELS;
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if ((!model || model === "auto") && harness === "cursor") throw new AgentRunnerConfigError("Choose a Cursor model before using Paperclip Runner.", ["model"]);
  return { adapterType: "paperclip_runner", adapterConfig: {
    ...config, ...profile,
    model: model || (harness === "grok_local" ? "grok-4.7" : PAPERCLIP_RUNNER_DEFAULT_MODELS[provider]),
    [capability.configKey]: config[capability.configKey] ?? capability.defaultMode,
    lifecycleMode: config.lifecycleMode ?? "per_turn",
  } };
}
