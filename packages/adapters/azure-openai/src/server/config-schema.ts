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
        hint: "Azure OpenAI resource endpoint (e.g. https://my-resource.openai.azure.com/) OR an Azure AI Foundry serverless inference endpoint (e.g. https://my-project.eastus2.inference.ai.azure.com/).",
      },
      {
        key: "deployment",
        label: "Deployment name",
        type: "text",
        required: true,
        hint: "Azure OpenAI: the deployment name from Azure AI Studio. Foundry serverless: leave empty (endpoint carries the model) or set to the target model id.",
      },
      {
        key: "apiVersion",
        label: "API version",
        type: "text",
        default: DEFAULT_API_VERSION,
        hint: "Azure OpenAI api-version query parameter. Ignored for Foundry serverless endpoints.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: true,
        hint: "Azure resource api-key (or Foundry inference key). Stored as a Paperclip secret.",
        meta: { secret: true },
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
        hint: "Selects the request URL shape and auth header. Azure OpenAI uses /openai/deployments/{name}/chat/completions?api-version=…; Foundry serverless uses /chat/completions.",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "textarea",
        hint: "Optional stable system message prepended to every chat request. Task-specific context still comes from the Paperclip wake payload.",
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
        hint: "Optional JSON object of extra non-secret headers (e.g. { \"x-ms-client-request-id\": \"…\" }). Authorization, api-key, and content-type are managed by the adapter.",
      },
    ],
  };
}
