export const ADAPTER_TYPE = "azure_openai";
export const ADAPTER_LABEL = "Azure OpenAI";

export const DEFAULT_API_VERSION = "2024-10-21";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.2;

export type DeploymentKind = "azure_openai" | "azure_ai_foundry";

/**
 * Endpoint URL construction mode.
 * - `deployment`: adapter builds the request URL from endpoint + deployment +
 *   apiVersion using the classic Azure OpenAI or Foundry serverless shapes.
 * - `raw`: adapter posts to `config.endpoint` verbatim. Use this for Foundry
 *   per-model / Agent endpoints where the full URL is copied from the portal
 *   (e.g. `https://x.services.ai.azure.com/openai/v1/responses`).
 */
export type EndpointMode = "deployment" | "raw";

/**
 * OpenAI-compatible request/response surface at the endpoint.
 * - `chat_completions`: `{messages, ...}` in, SSE `chat.completion.chunk` frames out.
 * - `responses`: OpenAI Responses API — `{input, ...}` in, SSE
 *   `response.output_text.delta` + `response.completed` events out. Foundry
 *   `/openai/v1/responses` and Agent endpoints speak this.
 * - `auto`: detect from URL (`/responses` suffix → responses; otherwise → chat_completions).
 */
export type ApiSurface = "chat_completions" | "responses" | "auto";
