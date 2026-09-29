import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, isCodexLocalKnownModel } from "@paperclipai/adapter-codex-local";
import { modelSupportsEffort, KIMI_SUPPORTED_EFFORTS } from "@paperclipai/adapter-kimi-local";
import { aiConnectionBindingSchema, type Agent, type IssueAssigneeAdapterOverrides } from "@paperclipai/shared";

export interface ComposerRunSettings {
  model: string | null;
  effort: string | null;
  fast: boolean;
}

export const DEFAULT_COMPOSER_RUN_SETTINGS: ComposerRunSettings = { model: null, effort: null, fast: false };
export const EFFORT_LABELS: Record<string, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra High", max: "Max", ultra: "Ultra",
};

const MODEL_ADAPTERS = new Set([
  "claude_local", "codex_local", "opencode_local", "pi_local", "kimi_local",
  "gemini_local", "cursor", "cursor_cloud", "grok_local", "hermes_local", "paperclip_runner",
]);

export function supportsComposerModel(agent: Agent | undefined): boolean {
  return Boolean(agent && MODEL_ADAPTERS.has(agent.adapterType));
}

export function composerCatalogProvider(agent: Agent | undefined): string | undefined {
  if (!agent) return undefined;
  if (agent.adapterType === "paperclip_runner") return String(agent.adapterConfig.provider ?? "codex");
  if (agent.adapterType !== "opencode_local") return undefined;
  const binding = aiConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection).data;
  const configuredModel = agent.adapterConfig.model;
  return binding?.provider === "openrouter" || typeof configuredModel === "string" && configuredModel.startsWith("openrouter/")
    ? "openrouter" : undefined;
}

export function composerEfforts(agent: Agent | undefined, model: string, catalogIds: readonly string[]): readonly string[] {
  if (!agent || !model) return [];
  if (agent.adapterType === "codex_local") {
    return isCodexLocalKnownModel(model) ? codexLocalReasoningEffortsForModel(model) : [];
  }
  if (!catalogIds.includes(model)) return [];
  if (agent.adapterType === "claude_local") return ["low", "medium", "high"];
  if (agent.adapterType === "pi_local") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (agent.adapterType === "kimi_local" && modelSupportsEffort(model)) return KIMI_SUPPORTED_EFFORTS;
  return [];
}

export function composerFastAvailable(agent: Agent | undefined, model: string): boolean {
  return Boolean(agent && agent.adapterType === "codex_local" && isCodexLocalKnownModel(model) && isCodexLocalFastModeSupported(model));
}

export function readComposerRunSettings(overrides: IssueAssigneeAdapterOverrides | null | undefined, adapterType: string | undefined): ComposerRunSettings {
  const config = overrides?.adapterConfig ?? {};
  const effortKey = composerEffortKey(adapterType);
  const effortValue = effortKey && (config[effortKey]
    ?? (adapterType === "codex_local" ? config.reasoningEffort ?? config.effort : undefined));
  return {
    model: typeof config.model === "string" ? config.model : null,
    effort: typeof effortValue === "string" ? effortValue : null,
    fast: adapterType === "codex_local" && config.fastMode === true,
  };
}

function composerEffortKey(adapterType: string | undefined): string | null {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "claude_local" || adapterType === "kimi_local") return "effort";
  if (adapterType === "pi_local") return "thinking";
  if (adapterType === "opencode_local") return "variant";
  return null;
}

export function mergeComposerRunSettings(
  previous: IssueAssigneeAdapterOverrides | null | undefined,
  adapterType: string | undefined,
  settings: ComposerRunSettings,
  reassigned = false,
): IssueAssigneeAdapterOverrides | null {
  const config = { ...(reassigned ? {} : previous?.adapterConfig) };
  delete config.model;
  delete config.modelReasoningEffort;
  delete config.reasoningEffort;
  delete config.effort;
  delete config.thinking;
  delete config.variant;
  delete config.fastMode;
  if (settings.model) config.model = settings.model;
  const effortKey = composerEffortKey(adapterType);
  if (settings.effort && effortKey) config[effortKey] = settings.effort;
  if (settings.fast && adapterType === "codex_local") config.fastMode = true;
  const useProjectWorkspace = reassigned ? undefined : previous?.useProjectWorkspace;
  return Object.keys(config).length || useProjectWorkspace !== undefined
    ? { ...(Object.keys(config).length ? { adapterConfig: config } : {}), ...(useProjectWorkspace !== undefined ? { useProjectWorkspace } : {}) }
    : null;
}
