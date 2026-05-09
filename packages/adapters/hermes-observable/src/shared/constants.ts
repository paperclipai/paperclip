export const ADAPTER_TYPE = "hermes_observable";
export const ADAPTER_LABEL = "Hermes Observable";

export const DEFAULT_HERMES_API_BASE_URL = "http://127.0.0.1:8000";
export const DEFAULT_ENDPOINT_MODE = "responses";
export const DEFAULT_MODEL = "hermes-agent";
export const DEFAULT_PROVIDER = "auto";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_HEARTBEAT_SEC = 30;

export const TOOL_OUTPUT_MAX_CHARS = 20_000;

export const PROVIDER_OPTIONS = [
  "auto",
  "anthropic",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "nous",
  "openai",
  "openai-codex",
  "openrouter",
  "zai",
] as const;

export type HermesEndpointMode = "responses" | "chat_completions";

export const HERMES_OBSERVABLE_EVENT_TYPES = {
  error: "hermes_observable.error",
  init: "hermes_observable.init",
  result: "hermes_observable.result",
  textDelta: "hermes_observable.text_delta",
  toolCall: "hermes_observable.tool_call",
  toolResult: "hermes_observable.tool_result",
} as const;
