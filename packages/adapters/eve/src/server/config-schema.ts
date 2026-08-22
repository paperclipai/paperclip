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
      {
        key: "runTimeoutMs",
        label: "Run timeout ms",
        type: "number",
        default: 1800000,
        hint: "Whole-run cap in milliseconds, default 1800000.",
      },
    ],
  };
}

export function getLocalConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "projectDir",
        label: "Eve project directory",
        type: "text",
        required: true,
        hint: "Absolute path to the Eve project (created with `npx eve init`). The adapter runs `eve dev --no-ui` from here for each run.",
      },
      {
        key: "command",
        label: "Eve command",
        type: "text",
        default: "eve",
        hint: 'Command used to launch the Eve dev server. Install Eve (npm i -g eve) or point this at another binary.',
      },
      {
        key: "port",
        label: "Port",
        type: "number",
        hint: "Fixed local port for the dev server. Leave empty to pick a free ephemeral port per run.",
      },
      {
        key: "env",
        label: "Environment variables",
        type: "textarea",
        hint: "Optional JSON object of environment variables injected into the Eve server process.",
        meta: { secret: true },
      },
      {
        key: "readyTimeoutMs",
        label: "Ready timeout ms",
        type: "number",
        default: 90000,
        hint: "How long to wait for the dev server to answer /eve/v1/info. First boot compiles the project and can take a while.",
      },
      {
        key: "runTimeoutMs",
        label: "Run timeout ms",
        type: "number",
        default: 1800000,
        hint: "Whole-run cap in milliseconds, default 1800000.",
      },
    ],
  };
}
