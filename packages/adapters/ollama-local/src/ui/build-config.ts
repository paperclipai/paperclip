import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  DEFAULT_OLLAMA_KEEP_ALIVE_SEC,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC,
  DEFAULT_OLLAMA_TEMPERATURE,
  DEFAULT_OLLAMA_TOP_P,
} from "../constants.js";

/**
 * Given the UI's shared CreateConfigValues, project out the subset of keys
 * that ollama_local actually stores on agentConfig. Unknown keys pass
 * through via adapterSchemaValues so the declarative schema UI can provide
 * new fields without code changes here.
 */
export function buildOllamaAdapterConfig(values: CreateConfigValues): Record<string, unknown> {
  const schemaValues = values.adapterSchemaValues ?? {};
  const pick = <K extends string>(key: K, fallback: unknown): unknown => {
    if (Object.prototype.hasOwnProperty.call(schemaValues, key)) {
      return schemaValues[key];
    }
    return fallback;
  };

  return {
    adapterType: "ollama_local",
    cwd: values.cwd || undefined,
    instructionsFilePath: values.instructionsFilePath || undefined,
    promptTemplate: values.promptTemplate || undefined,
    baseUrl: pick("baseUrl", DEFAULT_OLLAMA_BASE_URL),
    model: values.model?.trim() || pick("model", DEFAULT_OLLAMA_MODEL),
    contextWindow: pick("contextWindow", DEFAULT_OLLAMA_CONTEXT_WINDOW),
    keepAliveSec: pick("keepAliveSec", DEFAULT_OLLAMA_KEEP_ALIVE_SEC),
    requestTimeoutSec: pick("requestTimeoutSec", DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC),
    maxOutputTokens: pick("maxOutputTokens", 0),
    temperature: pick("temperature", DEFAULT_OLLAMA_TEMPERATURE),
    topP: pick("topP", DEFAULT_OLLAMA_TOP_P),
  };
}
