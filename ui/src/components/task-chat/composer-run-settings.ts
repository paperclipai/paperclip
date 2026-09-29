import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, isCodexLocalKnownModel } from "@paperclipai/adapter-codex-local";
import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { DEFAULT_GROK_LOCAL_MODEL, grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { DEFAULT_KIMI_LOCAL_MODEL, modelSupportsEffort, KIMI_SUPPORTED_EFFORTS } from "@paperclipai/adapter-kimi-local";
import { aiConnectionBindingSchema, type Agent, type IssueAssigneeAdapterOverrides } from "@paperclipai/shared";

export interface ComposerRunSettings {
  model: string | null;
  effort: string | null;
  fast: boolean;
  daybreak: boolean;
  /** Whether Daybreak is explicitly enabled/disabled for this task, or inherited. */
  daybreakOverride: "inherit" | "enabled" | "disabled";
}

export const DEFAULT_COMPOSER_RUN_SETTINGS: ComposerRunSettings = {
  model: null,
  effort: null,
  fast: false,
  daybreak: false,
  daybreakOverride: "inherit",
};
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
  if (!agent) return [];
  const effectiveModel = model.trim() || (agent.adapterType === "grok_local" ? DEFAULT_GROK_LOCAL_MODEL
    : agent.adapterType === "kimi_local" ? DEFAULT_KIMI_LOCAL_MODEL : "");
  if (!effectiveModel) return [];
  if (agent.adapterType === "codex_local" || (agent.adapterType === "paperclip_runner" && composerCatalogProvider(agent) === "codex")) {
    return isCodexLocalKnownModel(effectiveModel) ? codexLocalReasoningEffortsForModel(effectiveModel) : [];
  }
  if (!catalogIds.includes(effectiveModel)) return [];
  if (agent.adapterType === "claude_local") return claudeLocalReasoningEffortsForModel(effectiveModel);
  if (agent.adapterType === "grok_local") return grokLocalReasoningEffortsForModel(effectiveModel);
  if (agent.adapterType === "pi_local") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (agent.adapterType === "kimi_local" && typeof agent.adapterConfig.engine === "string"
    && agent.adapterConfig.engine.trim().toLowerCase() === "cli" && modelSupportsEffort(effectiveModel)) return KIMI_SUPPORTED_EFFORTS;
  return [];
}

export function composerFastAvailable(agent: Agent | undefined, model: string): boolean {
  return Boolean(agent && agent.adapterType === "codex_local" && isCodexLocalKnownModel(model) && isCodexLocalFastModeSupported(model));
}

/** Daybreak is a Codex account/workspace capability, not a model identifier. */
export function composerDaybreakAvailable(agent: Agent | undefined): boolean {
  return agent?.adapterType === "codex_local";
}

export function readComposerRunSettings(
  overrides: IssueAssigneeAdapterOverrides | null | undefined,
  adapterType: string | undefined,
  agentAdapterConfig?: Readonly<Record<string, unknown>>,
): ComposerRunSettings {
  const config = overrides?.adapterConfig ?? {};
  const effortKey = composerEffortKey(adapterType);
  const effortValue = effortKey && (config[effortKey]
    ?? (adapterType === "codex_local" || adapterType === "paperclip_runner" ? config.reasoningEffort ?? config.effort : undefined));
  return {
    model: typeof config.model === "string" ? config.model : null,
    effort: typeof effortValue === "string" ? effortValue : null,
    fast: adapterType === "codex_local" && config.fastMode === true,
    daybreak: adapterType === "codex_local" && (
      config.daybreakEnabled === true
      || config.daybreakEnabled === undefined && agentAdapterConfig?.daybreakEnabled === true
    ),
    daybreakOverride: adapterType === "codex_local" && typeof config.daybreakEnabled === "boolean"
      ? config.daybreakEnabled ? "enabled" : "disabled"
      : "inherit",
  };
}

function composerEffortKey(adapterType: string | undefined): string | null {
  if (adapterType === "codex_local" || adapterType === "paperclip_runner") return "modelReasoningEffort";
  if (adapterType === "claude_local" || adapterType === "kimi_local") return "effort";
  if (adapterType === "grok_local") return "reasoningEffort";
  if (adapterType === "pi_local") return "thinking";
  if (adapterType === "opencode_local") return "variant";
  return null;
}

export function mergeComposerRunSettings(
  previous: IssueAssigneeAdapterOverrides | null | undefined,
  adapterType: string | undefined,
  settings: ComposerRunSettings,
  reassigned = false,
  agentAdapterConfig?: Readonly<Record<string, unknown>>,
): IssueAssigneeAdapterOverrides | null {
  const config = { ...(reassigned ? {} : previous?.adapterConfig) };
  delete config.model;
  delete config.modelReasoningEffort;
  delete config.reasoningEffort;
  delete config.effort;
  delete config.thinking;
  delete config.variant;
  delete config.fastMode;
  delete config.daybreakEnabled;
  if (settings.model) config.model = settings.model;
  const effortKey = composerEffortKey(adapterType);
  if (settings.effort && effortKey) config[effortKey] = settings.effort;
  if (settings.fast && adapterType === "codex_local") config.fastMode = true;
  if (adapterType === "codex_local") {
    if (settings.daybreakOverride === "enabled") config.daybreakEnabled = true;
    else if (settings.daybreakOverride === "disabled") config.daybreakEnabled = false;
  }
  const useProjectWorkspace = reassigned ? undefined : previous?.useProjectWorkspace;
  return Object.keys(config).length || useProjectWorkspace !== undefined
    ? { ...(Object.keys(config).length ? { adapterConfig: config } : {}), ...(useProjectWorkspace !== undefined ? { useProjectWorkspace } : {}) }
    : null;
}
