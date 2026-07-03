import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Eve agent base URL",
        type: "text",
        required: true,
        hint: "Root URL of the running Eve agent, e.g. https://my-agent.vercel.app or http://127.0.0.1:3000.",
      },
      {
        key: "headers",
        label: "Request headers",
        type: "textarea",
        hint: 'Optional JSON object of static request headers, e.g. {"Authorization": "Bearer <token>"} for deployed targets.',
        meta: { secret: true },
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        hint: "Informational only — Eve agents pin their own model. Reported on run results.",
      },
      {
        key: "timeoutMs",
        label: "Request timeout ms",
        type: "number",
        default: 30000,
        hint: "Per-HTTP-request timeout in milliseconds.",
      },
    ],
  };
}
