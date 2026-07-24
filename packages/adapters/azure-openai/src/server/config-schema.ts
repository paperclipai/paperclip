import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_API_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "endpoint",
        label: "Endpoint URL",
        type: "text",
        required: true,
        hint: "Azure OpenAI resource endpoint (e.g. https://my-resource.openai.azure.com/), Azure AI Foundry serverless URL, or — with endpointMode=raw — the full API path shown in the portal (e.g. https://my-project.services.ai.azure.com/openai/v1/responses).",
      },
      {
        key: "endpointMode",
        label: "Endpoint mode",
        type: "select",
        default: "deployment",
        options: [
          { value: "deployment", label: "Deployment (adapter builds the URL)" },
          { value: "raw", label: "Raw (POST to endpoint as-given)" },
        ],
        hint: "Use `raw` for Foundry per-model / Agent endpoints where the full URL is copied from the portal.",
      },
      {
        key: "deployment",
        label: "Deployment name",
        type: "text",
        required: false,
        hint: "Azure OpenAI (endpointMode=deployment): the deployment name from Azure AI Studio. Ignored for endpointMode=raw or Foundry serverless.",
      },
      {
        key: "apiVersion",
        label: "API version",
        type: "text",
        default: DEFAULT_API_VERSION,
        hint: "Azure OpenAI api-version query parameter. Ignored for endpointMode=raw and Foundry serverless.",
      },
      {
        key: "deploymentKind",
        label: "Deployment kind",
        type: "select",
        default: "azure_openai",
        options: [
          { value: "azure_openai", label: "Azure OpenAI (deployment-scoped URL)" },
          { value: "azure_ai_foundry", label: "Azure AI Foundry (serverless endpoint)" },
        ],
        hint: "Selects the URL shape when endpointMode=deployment.",
      },
      {
        key: "apiSurface",
        label: "API surface",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto-detect from URL (recommended)" },
          { value: "chat_completions", label: "Chat Completions" },
          { value: "responses", label: "Responses API" },
        ],
        hint: "Selects the request/response shape. `auto` treats URLs ending in `/responses` as Responses API; everything else as Chat Completions.",
      },
      {
        key: "authMode",
        label: "Authentication mode",
        type: "select",
        default: "api_key",
        options: [
          { value: "api_key", label: "API key (api-key header)" },
          { value: "bearer", label: "Bearer token (Authorization header, operator-managed)" },
          { value: "azure_ad", label: "Azure AD (DefaultAzureCredential)" },
        ],
        hint: "Many enterprise Azure OpenAI resources disable api-key auth; use `azure_ad` (needs @azure/identity) or `bearer` with an operator-refreshed token in those tenants.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: false,
        hint: "Required when authMode=api_key. Stored as a Paperclip secret.",
        meta: { secret: true },
      },
      {
        key: "bearerToken",
        label: "Bearer token",
        type: "text",
        required: false,
        hint: "Required when authMode=bearer. Stored as a Paperclip secret. Adapter does NOT refresh — keep it fresh externally (e.g. `az account get-access-token --resource https://cognitiveservices.azure.com`).",
        meta: { secret: true },
      },
      {
        key: "aadScope",
        label: "AAD scope",
        type: "text",
        default: "https://cognitiveservices.azure.com/.default",
        hint: "Only used when authMode=azure_ad. Override only when your resource requires a non-standard scope.",
      },
      {
        key: "model",
        label: "Model (Responses API)",
        type: "text",
        required: false,
        hint: "Optional model id sent in the request body (e.g. `gpt-4o`). Some Responses-API endpoints require it; deployment-URL endpoints usually don't.",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "textarea",
        hint: "Optional stable system message. Rendered as `system` message for Chat Completions and as `instructions` for the Responses API.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: DEFAULT_TEMPERATURE,
      },
      {
        key: "maxOutputTokens",
        label: "Max output tokens",
        type: "number",
        default: DEFAULT_MAX_OUTPUT_TOKENS,
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "headers",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of extra non-secret headers. Adapter-managed headers (Authorization / api-key / content-type / accept) cannot be overridden.",
      },
    ],
  };
}
