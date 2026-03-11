import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildSandboxConfig(values: CreateConfigValues): Record<string, unknown> {
  const providerType = values.sandboxProviderType || "e2b";
  let providerConfig: Record<string, unknown>;

  if (providerType === "e2b") {
    providerConfig = {
      template: values.sandboxTemplate || undefined,
      domain: values.sandboxDomain || undefined,
    };
  } else if (providerType === "opensandbox") {
    providerConfig = {
      domain: values.sandboxDomain || undefined,
      image: values.sandboxImage || undefined,
    };
  } else {
    providerConfig = {
      baseUrl: values.sandboxBaseUrl,
      namespace: values.sandboxNamespace || "paperclip",
      instanceType: values.sandboxInstanceType || "standard",
      image: values.sandboxImage || undefined,
    };
  }

  const config: Record<string, unknown> = {
    providerType,
    sandboxAgentType: values.sandboxAgentType || "claude_local",
    keepAlive: values.sandboxKeepAlive,
    providerConfig,
    timeoutSec: 0,
    graceSec: 20,
  };

  if (values.cwd) config.cwd = values.cwd;
  if (values.sandboxBootstrapCommand) config.bootstrapCommand = values.sandboxBootstrapCommand;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.bootstrapPrompt) config.bootstrapPromptTemplate = values.bootstrapPrompt;
  if (values.command) config.command = values.command;
  if (values.model) config.model = values.model;
  if (values.extraArgs) config.extraArgs = parseCommaArgs(values.extraArgs);
  if (Object.keys(values.envBindings ?? {}).length > 0) config.env = values.envBindings;

  if (values.sandboxAgentType === "claude_local") {
    if (values.thinkingEffort) config.effort = values.thinkingEffort;
    config.chrome = values.chrome;
    config.dangerouslySkipPermissions = values.dangerouslySkipPermissions;
    config.maxTurnsPerRun = values.maxTurnsPerRun;
  } else if (values.sandboxAgentType === "codex_local") {
    if (values.thinkingEffort) config.modelReasoningEffort = values.thinkingEffort;
    config.search = values.search;
    config.dangerouslyBypassApprovalsAndSandbox = values.dangerouslyBypassSandbox;
  } else if (values.sandboxAgentType === "cursor") {
    if (values.thinkingEffort) config.mode = values.thinkingEffort;
  } else if (values.sandboxAgentType === "opencode_local") {
    if (values.thinkingEffort) config.variant = values.thinkingEffort;
  }

  return config;
}
