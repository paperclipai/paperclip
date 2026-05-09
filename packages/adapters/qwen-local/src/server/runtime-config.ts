import { asString } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_QWEN_LOCAL_MODEL } from "../index.js";

export interface PreparedQwenRuntimeConfig {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
}

export interface QwenResolvedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class QwenAdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenAdapterConfigError";
  }
}

// Read + validate the user-facing config fields needed for an OpenAI-compatible
// run. Throws on missing required values so the run fails fast with a clear
// reason instead of silently sending requests to nowhere.
export function resolveQwenConfig(config: Record<string, unknown>): QwenResolvedConfig {
  const baseUrl = asString(config.baseUrl, "").trim();
  if (!baseUrl) {
    throw new QwenAdapterConfigError(
      "qwen_local agent requires `baseUrl` (vLLM OpenAI-compatible endpoint, e.g. http://dgx:8000/v1)",
    );
  }
  const apiKey = asString(config.apiKey, "").trim();
  if (!apiKey) {
    throw new QwenAdapterConfigError(
      "qwen_local agent requires `apiKey` (vLLM bearer token; use a stub like `sk-local` if vLLM is unauthenticated)",
    );
  }
  const model = asString(config.model, DEFAULT_QWEN_LOCAL_MODEL).trim();
  return { baseUrl, apiKey, model };
}

// Inject OPENAI_* env vars so qwen-code routes inference at the configured
// vLLM endpoint. Keep the API key out of CLI flags so it does not appear in
// process listings (`ps`, `/proc`, audit logs).
export async function prepareQwenRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedQwenRuntimeConfig> {
  const resolved = resolveQwenConfig(input.config);
  const env: Record<string, string> = {
    ...input.env,
    OPENAI_BASE_URL: resolved.baseUrl,
    OPENAI_API_KEY: resolved.apiKey,
    OPENAI_MODEL: resolved.model,
  };
  return {
    env,
    notes: [
      `Routing inference at ${resolved.baseUrl} via OPENAI_BASE_URL (qwen-code OpenAI-compatible mode).`,
    ],
    cleanup: async () => {},
  };
}
