import { t, useTranslation } from "@/i18n";
import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, isCodexLocalKnownModel } from "@paperclipai/adapter-codex-local";
import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { resolvePaperclipRunnerModel } from "@paperclipai/adapter-utils";
import { DEFAULT_GROK_LOCAL_MODEL, grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { DEFAULT_KIMI_LOCAL_MODEL, modelSupportsEffort, KIMI_SUPPORTED_EFFORTS } from "@paperclipai/adapter-kimi-local";
import { aiConnectionBindingSchema, aiRuntimeConnectionBindingSchema, type Agent, type IssueAssigneeAdapterOverrides } from "@paperclipai/shared";

export interface ComposerRunSettings {
  model: string | null;
  effort: string | null;
  fast: boolean;
}

export const DEFAULT_COMPOSER_RUN_SETTINGS: ComposerRunSettings = { model: null, effort: null, fast: false };
export const EFFORT_LABELS: Record<string, string> = {
  get off() { return t("oct5Core.s0264"); }, get minimal() { return t("oct5Core.s0265"); }, get low() { return t("oct5Core.s0266"); }, get medium() { return t("oct5Core.s0267"); }, get high() { return t("oct5Core.s0268"); },
  get xhigh() { return t("oct5Core.s0269"); }, get max() { return t("oct5Core.s0270"); }, get ultra() { return t("oct5Core.s0271"); },
};

const MODEL_ADAPTERS = new Set([
  "claude_local", "codex_local", "opencode_local", "pi_local", "kimi_local",
  "gemini_local", "cursor", "cursor_cloud", "grok_local", "hermes_local", "paperclip_runner",
]);

export function supportsComposerModel(agent: Agent | undefined): boolean {
  return Boolean(agent && MODEL_ADAPTERS.has(agent.adapterType));
}

/** Resolve visible defaults; host environment and a local CLI's own config are unknown. */
export function composerDefaultModel(agent: Agent | undefined): string {
  if (!agent) return "";
  const config = agent.adapterConfig;
  const configured = typeof config.model === "string" ? config.model.trim() : "";
  if (configured) return configured;
  if (agent.adapterType === "claude_local") {
    const env = config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? config.env as Record<string, unknown> : {};
    // The server merges host env too, which may select a different model or
    // Bedrock/Vertex. Without an explicit agent setting, the default is unknown.
    return typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
  }
  if (agent.adapterType === "grok_local") return DEFAULT_GROK_LOCAL_MODEL;
  if (agent.adapterType === "kimi_local") return DEFAULT_KIMI_LOCAL_MODEL;
  if (agent.adapterType === "paperclip_runner") {
    const provider = composerCatalogProvider(agent);
    if (provider === "codex" || provider === "opencode") return resolvePaperclipRunnerModel(provider, config.model);
    if (provider === "acpx" && config.acpxAgent !== "grok") return resolvePaperclipRunnerModel(provider, config.model);
  }
  return "";
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
  const pool = aiRuntimeConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection).data?.mode === "router";
  if (pool && agent.adapterType === "paperclip_runner") return isCodexLocalKnownModel(effectiveModel) ? codexLocalReasoningEffortsForModel(effectiveModel) : [];
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

export function readComposerRunSettings(overrides: IssueAssigneeAdapterOverrides | null | undefined, adapterType: string | undefined): ComposerRunSettings {
  const config = overrides?.adapterConfig ?? {};
  const effortKey = composerEffortKey(adapterType);
  const effortValue = effortKey && (config[effortKey]
    ?? (adapterType === "codex_local" || adapterType === "paperclip_runner" ? config.reasoningEffort ?? config.effort : undefined));
  return {
    model: typeof config.model === "string" ? config.model : null,
    effort: typeof effortValue === "string" ? effortValue : null,
    fast: adapterType === "codex_local" && config.fastMode === true,
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
