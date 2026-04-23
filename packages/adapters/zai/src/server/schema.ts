import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_ZAI_BASE_URL } from "../index.js";

// The "model" field is intentionally NOT declared here — the agent form's
// main ModelDropdown already renders it (populated from listZaiModels()).
// Adding it again in the schema would produce a duplicate selector.
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
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
