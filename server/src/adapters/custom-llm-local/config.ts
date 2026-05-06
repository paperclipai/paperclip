import type { AdapterConfigSchema } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";

export const CUSTOM_LLM_LOCAL_TRANSPORTS = [
  "openai_chat_completions",
  "anthropic_messages",
] as const;

export type CustomLlmLocalTransport = (typeof CUSTOM_LLM_LOCAL_TRANSPORTS)[number];

export interface CustomLlmLocalConfig {
  model: string;
  baseUrl: string;
  transport: CustomLlmLocalTransport;
  apiKeyEnv: string | null;
  instructionsFilePath: string | null;
  promptTemplate: string | null;
  timeoutSec: number;
  graceSec: number;
  extraHeaders: Record<string, string>;
  modelAlias: string | null;
}

function parseStringHeaders(value: unknown): Record<string, string> {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          const json = JSON.parse(value);
          return typeof json === "object" && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : {};
        } catch {
          return {};
        }
      })()
    : parseObject(value);

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

export function parseCustomLlmLocalConfig(raw: Record<string, unknown>): CustomLlmLocalConfig {
  if ("apiKey" in raw && raw.apiKey !== null && raw.apiKey !== undefined && raw.apiKey !== "") {
    throw new Error("CONFIG_INVALID: raw apiKey is not supported; use apiKeyEnv instead");
  }

  const model = asString(raw.model, "").trim();
  if (!model) {
    throw new Error("CONFIG_INVALID: model is required");
  }

  const baseUrl = asString(raw.baseUrl, asString(raw.url, "")).trim();
  if (!baseUrl) {
    throw new Error("CONFIG_INVALID: baseUrl is required");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("CONFIG_INVALID: baseUrl must be an absolute http/https URL");
  }
  if ((parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") || !parsedBaseUrl.host) {
    throw new Error("CONFIG_INVALID: baseUrl must be an absolute http/https URL");
  }

  const transport = asString(raw.transport, "") as CustomLlmLocalTransport;
  if (!CUSTOM_LLM_LOCAL_TRANSPORTS.includes(transport)) {
    throw new Error(
      `CONFIG_INVALID: transport must be one of ${CUSTOM_LLM_LOCAL_TRANSPORTS.join(", ")} — got "${transport}"`,
    );
  }

  const timeoutSec = Math.max(1, asNumber(raw.timeoutSec, 300));
  const graceSec = Math.max(0, asNumber(raw.graceSec, 30));

  return {
    model,
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    transport,
    apiKeyEnv: asString(raw.apiKeyEnv, "").trim() || null,
    instructionsFilePath: asString(raw.instructionsFilePath, "").trim() || null,
    promptTemplate: asString(raw.promptTemplate, "").trim() || null,
    timeoutSec,
    graceSec,
    extraHeaders: parseStringHeaders(raw.extraHeaders),
    modelAlias: asString(raw.modelAlias, "").trim() || null,
  };
}

export function getCustomLlmLocalConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        required: true,
        hint: "Absolute HTTP or HTTPS base URL, for example http://127.0.0.1:8080/v1",
      },
      {
        key: "transport",
        label: "Transport",
        type: "select",
        required: true,
        default: "openai_chat_completions",
        options: [
          { value: "openai_chat_completions", label: "OpenAI Chat Completions" },
          { value: "anthropic_messages", label: "Anthropic Messages" },
        ],
        hint: "API format exposed by the target endpoint",
      },
      {
        key: "apiKeyEnv",
        label: "API Key Env Var",
        type: "text",
        hint: "Name of the Paperclip server environment variable holding the API key",
      },
      {
        key: "modelAlias",
        label: "Model Alias",
        type: "text",
        hint: "Optional canonical or display model identifier stored in result JSON",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions File Path",
        type: "text",
        hint: "Absolute path to a markdown instructions file loaded on each run",
      },
      {
        key: "promptTemplate",
        label: "Prompt Template",
        type: "textarea",
        hint: "Optional Paperclip wake prompt template appended after the rendered wake context",
      },
      {
        key: "extraHeaders",
        label: "Extra Headers (JSON)",
        type: "textarea",
        hint: "Optional JSON object of additional request headers merged into the upstream request",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 300,
      },
      {
        key: "graceSec",
        label: "Grace Period (seconds)",
        type: "number",
        default: 30,
        hint: "Extra time to wait after the soft timeout before the HTTP request is aborted",
      },
    ],
  };
}
