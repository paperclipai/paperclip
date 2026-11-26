import { codexLocalReasoningEffortsForModel, DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { claudeLocalReasoningEffortsForModel, DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { unprocessable } from "../../errors.js";

function effortSettings(adapterType: string, config: Record<string, unknown>) {
  if (adapterType === "codex_local" || (adapterType === "paperclip_runner" && (config.provider ?? "codex") === "codex")) {
    return { field: "modelReasoningEffort", supported: codexLocalReasoningEffortsForModel(typeof config.model === "string" ? config.model : DEFAULT_CODEX_LOCAL_MODEL) };
  }
  if (adapterType === "claude_local") {
    return { field: "effort", supported: claudeLocalReasoningEffortsForModel(typeof config.model === "string" ? config.model : DEFAULT_CLAUDE_LOCAL_MODEL) };
  }
  return { field: null, supported: [] as readonly string[] };
}

/** Translate the assistant's neutral setting at the live adapter boundary. */
export function applyMcpReasoningEffort(adapterType: string, config: Record<string, unknown>, requested: Record<string, unknown>) {
  const settings = effortSettings(adapterType, config);
  const explicit = Object.hasOwn(requested, "reasoningEffort");
  const effort = explicit ? requested.reasoningEffort : settings.field ? config[settings.field] ?? config.reasoningEffort : undefined;
  if (effort !== undefined && (explicit || Object.hasOwn(requested, "model"))) {
    if (!settings.field || typeof effort !== "string" || !settings.supported.includes(effort)) {
      throw unprocessable("Reasoning effort is unsupported for this adapter and model", { code: "MCP_REASONING_EFFORT_UNSUPPORTED", supportedReasoningEfforts: settings.supported });
    }
  }
  if (!explicit || !settings.field) return config;
  const result = { ...config, [settings.field]: effort };
  delete result.reasoningEffort;
  return result;
}

export function mcpAgentModelConfig(adapterType: string, config: Record<string, unknown>) {
  const settings = effortSettings(adapterType, config);
  return {
    ...(typeof config.model === "string" ? { model: config.model } : {}),
    ...(settings.field && (config[settings.field] ?? config.reasoningEffort) !== undefined
      ? { reasoningEffort: config[settings.field] ?? config.reasoningEffort } : {}),
    supportedReasoningEfforts: settings.supported,
  };
}
