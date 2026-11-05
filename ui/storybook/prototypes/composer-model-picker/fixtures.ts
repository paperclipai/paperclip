import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, isCodexLocalKnownModel } from "@paperclipai/adapter-codex-local";
import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { DEFAULT_GROK_LOCAL_MODEL, grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { DEFAULT_KIMI_LOCAL_MODEL, modelSupportsEffort, KIMI_SUPPORTED_EFFORTS } from "@paperclipai/adapter-kimi-local";
import { AGENT_PALETTE_IDS, appearanceForPalette } from "@paperclipai/shared";

export type ModelOption = { id: string; label: string; detail?: string };
export type ComposerAgent = {
  id: string;
  name: string;
  role: string;
  harness: string;
  adapterType: string;
  provider?: string;
  engine?: string;
  defaultModel?: string;
  defaultLabel?: string;
  models: ModelOption[];
  manualPattern?: string;
  noModelReason?: string;
};

const codexModels: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", detail: "Agent default" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", detail: "Extended effort range" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", detail: "Fast mode unavailable" },
];

export const composerAgents: ComposerAgent[] = [
  { id: "codex", name: "Codie", role: "Engineering", harness: "Codex", adapterType: "codex_local", defaultModel: "gpt-5.6-sol", models: codexModels, manualPattern: "Model ID, e.g. gpt-5.6-sol" },
  { id: "claude", name: "Clara", role: "Research", harness: "Claude Code", adapterType: "claude_local", defaultModel: "claude-sonnet-5", models: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ], manualPattern: "Claude model ID" },
  { id: "openrouter", name: "Nora", role: "Product", harness: "OpenCode", adapterType: "opencode_local", provider: "OpenRouter", defaultModel: "openrouter/anthropic/claude-sonnet-4.6", models: [
    { id: "openrouter/anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", detail: "OpenRouter" },
    { id: "openrouter/google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", detail: "OpenRouter" },
    { id: "openrouter/deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", detail: "OpenRouter" },
  ], manualPattern: "openrouter/provider/model" },
  { id: "pi", name: "Pia", role: "Tooling", harness: "Pi", adapterType: "pi_local", defaultModel: "openrouter/anthropic/claude-sonnet-4.6", models: [
    { id: "openrouter/anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", detail: "OpenRouter" },
    { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", detail: "OpenAI" },
  ], manualPattern: "provider/model" },
  { id: "kimi", name: "Kimi", role: "Planning", harness: "Kimi Code", adapterType: "kimi_local", provider: "CLI engine", engine: "cli", defaultModel: "kimi-code/k3", models: [
    { id: "kimi-code/k3", label: "K3", detail: "Supports effort on CLI" },
    { id: "kimi-code/kimi-for-coding", label: "K2.8 Preview", detail: "Supports effort on CLI" },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Coding Highspeed", detail: "Uses model default" },
    { id: "kimi-code/k3-256k", label: "K3 (256K)", detail: "Supports effort on CLI" },
  ], manualPattern: "kimi-code/model" },
  { id: "gemini", name: "Gem", role: "Analysis", harness: "Gemini CLI", adapterType: "gemini_local", defaultModel: "auto", models: [
    { id: "auto", label: "Auto" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ], manualPattern: "Gemini model ID" },
  { id: "cursor", name: "Cora", role: "Design", harness: "Cursor", adapterType: "cursor", defaultModel: "auto", models: [
    { id: "auto", label: "Auto" },
    { id: "composer-1.5", label: "Composer 1.5" },
    { id: "sonnet-4.6", label: "Sonnet 4.6" },
  ], manualPattern: "Cursor model ID" },
  { id: "cursor-cloud", name: "Cloudy", role: "Remote engineering", harness: "Cursor Cloud", adapterType: "cursor_cloud", defaultLabel: "Account default", models: [], manualPattern: "Cursor Cloud model ID" },
  { id: "runner", name: "Runa", role: "Operations", harness: "Paperclip Runner", adapterType: "paperclip_runner", provider: "Codex profile", defaultModel: "gpt-5.6-sol", models: codexModels, manualPattern: "Codex model ID" },
  { id: "grok", name: "Grok", role: "Investigation", harness: "Grok CLI", adapterType: "grok_local", defaultModel: "grok-build", models: [
    { id: "grok-build", label: "Grok Build" },
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ], manualPattern: "Grok model ID" },
  { id: "hermes", name: "Hermes", role: "Operations", harness: "Hermes CLI", adapterType: "hermes_local", defaultModel: "auto", models: [{ id: "auto", label: "Auto" }], manualPattern: "Hermes model ID" },
  { id: "process", name: "Relay", role: "Automation", harness: "Process", adapterType: "process", models: [], noModelReason: "This agent runs a command. Its harness does not expose a model or effort setting." },
  { id: "http", name: "Hook", role: "Integration", harness: "HTTP", adapterType: "http", models: [], noModelReason: "This agent calls an HTTP endpoint. The destination service chooses its model." },
  { id: "openclaw", name: "Ollie", role: "Support", harness: "OpenClaw Gateway", adapterType: "openclaw_gateway", models: [], noModelReason: "This gateway chooses its model remotely; Paperclip has no model catalog or per-message setting for it." },
  { id: "hermes-gateway", name: "Hera", role: "Remote operations", harness: "Hermes Gateway", adapterType: "hermes_gateway", models: [], noModelReason: "This Hermes gateway chooses its model remotely; Paperclip cannot override it here." },
  { id: "kimi-acp", name: "Kima", role: "Planning", harness: "Kimi Code", adapterType: "kimi_local", provider: "ACP engine", engine: "acp", defaultModel: "kimi-code/k3", models: [
    { id: "kimi-code/k3", label: "K3" },
    { id: "kimi-code/kimi-for-coding", label: "K2.8 Preview" },
  ], manualPattern: "kimi-code/model" },
  { id: "grok-default", name: "Grok Default", role: "Investigation", harness: "Grok CLI", adapterType: "grok_local", models: [
    { id: "grok-build", label: "Grok Build" },
    { id: "grok-4.7", label: "Grok 4.7" },
  ], manualPattern: "Grok model ID" },
  { id: "kimi-cli-default", name: "Kimi Default", role: "Planning", harness: "Kimi Code", adapterType: "kimi_local", provider: "CLI engine", engine: " CLI ", models: [
    { id: "kimi-code/kimi-for-coding", label: "K2.8 Preview" },
    { id: "kimi-code/k3", label: "K3" },
  ], manualPattern: "kimi-code/model" },
  { id: "long-labels", name: "Alexandra Engineering Coordinator", role: "Engineering", harness: "Codex", adapterType: "codex_local", defaultModel: "gpt-5.6-sol", models: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol Extended Context Preview", detail: "Agent default" },
  ], manualPattern: "Model ID, e.g. gpt-5.6-sol" },
];

/** Share the capsule-avatar palettes used by the agent persona stories. */
export function composerAgentAppearance(agentId: string) {
  const index = Math.max(0, composerAgents.findIndex((agent) => agent.id === agentId));
  return appearanceForPalette(AGENT_PALETTE_IDS[index % AGENT_PALETTE_IDS.length]);
}

export const effortLabels: Record<string, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra", off: "Off",
};

export function effortChoices(agent: ComposerAgent, model: string): readonly string[] {
  const effectiveModel = model.trim() || (agent.adapterType === "grok_local" ? DEFAULT_GROK_LOCAL_MODEL
    : agent.adapterType === "kimi_local" ? DEFAULT_KIMI_LOCAL_MODEL : "");
  if (agent.adapterType === "codex_local" || agent.id === "runner") return isCodexLocalKnownModel(effectiveModel) ? codexLocalReasoningEffortsForModel(effectiveModel) : [];
  if (!agent.models.some((option) => option.id === effectiveModel)) return [];
  if (agent.adapterType === "claude_local") return claudeLocalReasoningEffortsForModel(effectiveModel);
  if (agent.adapterType === "grok_local") return grokLocalReasoningEffortsForModel(effectiveModel);
  if (agent.adapterType === "pi_local") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (agent.adapterType === "kimi_local" && agent.engine?.trim().toLowerCase() === "cli" && modelSupportsEffort(effectiveModel)) return KIMI_SUPPORTED_EFFORTS;
  // The current model API only returns id/label. OpenCode/OpenRouter variants are
  // model-specific, so a guessed generic slider would send unsupported values.
  return [];
}

export function fastModeAvailable(agent: ComposerAgent, model: string): boolean {
  return agent.adapterType === "codex_local"
    && isCodexLocalKnownModel(model)
    && isCodexLocalFastModeSupported(model);
}

export function modelLabel(agent: ComposerAgent, model: string): string {
  if (!model) return agent.defaultLabel ?? "Default";
  return agent.models.find((option) => option.id === model)?.label ?? model;
}
