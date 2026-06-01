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
        default: "deepseek-v4-flash",
        options: [
          { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
          { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
          { value: "deepseek-chat", label: "DeepSeek Chat (legacy alias)" },
          { value: "deepseek-reasoner", label: "DeepSeek Reasoner (legacy)" },
        ],
        hint: "DeepSeek model id. V4 Pro is the strongest; V4 Flash is faster/cheaper.",
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
