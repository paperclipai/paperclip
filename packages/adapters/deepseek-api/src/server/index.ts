export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: "deepseek-chat",
        options: [
          { value: "deepseek-chat", label: "DeepSeek Chat (V3)" },
          { value: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
        ],
        hint: "DeepSeek model id. deepseek-reasoner exposes chain-of-thought reasoning.",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: "https://api.deepseek.com/v1",
        hint: "Override only when proxying through a private gateway.",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "text",
        hint: "Optional system message prepended to every turn.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "text",
        hint: "Sampling temperature 0.0 - 2.0. Leave blank for provider default.",
      },
      {
        key: "maxTokens",
        label: "Max output tokens",
        type: "text",
        hint: "Cap on output tokens per turn. Leave blank for provider default.",
      },
      {
        key: "timeoutSec",
        label: "Request timeout (s)",
        type: "text",
        default: "600",
        hint: "Abort the request after this many seconds.",
      },
    ],
  };
}
