import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { models, DEFAULT_ZAI_BASE_URL } from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        required: true,
        default: "glm-4.6",
        options: models.map((model) => ({ label: model.label, value: model.id })),
        group: "model",
        hint: "GLM model id. GLM-4.6 is recommended for agent/tool workloads.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: false,
        group: "auth",
        hint: "Z.AI API key. Falls back to the ZAI_API_KEY environment variable when empty.",
        meta: { secret: true },
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        required: false,
        default: DEFAULT_ZAI_BASE_URL,
        group: "auth",
        hint: "Z.AI API base URL. Default: https://api.z.ai/api/paas/v4",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "textarea",
        required: false,
        group: "behavior",
        hint: "Prepended as role=system on every request.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        required: false,
        group: "behavior",
      },
      {
        key: "maxTokens",
        label: "Max tokens",
        type: "number",
        required: false,
        group: "behavior",
      },
      {
        key: "stream",
        label: "Stream responses",
        type: "toggle",
        required: false,
        default: true,
        group: "behavior",
        hint: "When on, incremental tokens are streamed to the transcript via SSE.",
      },
      {
        key: "responseFormat",
        label: "Response format",
        type: "select",
        required: false,
        group: "behavior",
        default: "text",
        options: [
          { label: "Text", value: "text" },
          { label: "JSON object", value: "json_object" },
        ],
        hint: "Force GLM to return a parseable JSON object (structured output mode).",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number",
        required: false,
        default: 60000,
        group: "behavior",
      },
    ],
  };
}
