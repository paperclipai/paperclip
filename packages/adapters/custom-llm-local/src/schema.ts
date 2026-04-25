import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type Transport = "openai_chat_completions" | "anthropic_messages";
const VALID_TRANSPORTS: Transport[] = ["openai_chat_completions", "anthropic_messages"];

export interface CustomLlmLocalConfig {
  model: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  transport: Transport;
  timeoutSec: number;
  graceSec: number;
  instructionsFilePath: string | null;
  extraHeaders: Record<string, string>;
  modelAlias: string | null;
}

export function parseConfig(raw: Record<string, unknown>): CustomLlmLocalConfig {
  // Reject raw apiKey per plan §5.2 — hard reject, no compat shim
  if ("apiKey" in raw && raw.apiKey != null && raw.apiKey !== "") {
    throw new Error("CONFIG_INVALID: raw apiKey is not supported; use apiKeyEnv instead");
  }

  const model = asString(raw.model, "").trim();
  if (!model) throw new Error("CONFIG_INVALID: model is required");

  const baseUrl = asString(raw.baseUrl, "").trim();
  if (!baseUrl) throw new Error("CONFIG_INVALID: baseUrl is required");
  try {
    const parsedBaseUrl = new URL(baseUrl);
    if ((parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") || !parsedBaseUrl.host) {
      throw new Error("invalid protocol or host");
    }
  } catch {
    throw new Error("CONFIG_INVALID: baseUrl must be an absolute http/https URL");
  }

  const transport = asString(raw.transport, "") as Transport;
  if (!VALID_TRANSPORTS.includes(transport)) {
    throw new Error(
      `CONFIG_INVALID: transport must be one of ${VALID_TRANSPORTS.join(", ")} — got "${transport}"`,
    );
  }

  const apiKeyEnv = asString(raw.apiKeyEnv, "").trim() || null;
  const instructionsFilePath = asString(raw.instructionsFilePath, "").trim() || null;
  const modelAlias = asString(raw.modelAlias, "").trim() || null;
  const timeoutSec = asNumber(raw.timeoutSec, 300);
  const graceSec = asNumber(raw.graceSec, 30);

  const rawHeaders = parseObject(raw.extraHeaders);
  const extraHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === "string") extraHeaders[k] = v;
  }

  return { model, baseUrl, apiKeyEnv, transport, timeoutSec, graceSec, instructionsFilePath, extraHeaders, modelAlias };
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model ID",
        type: "text",
        required: true,
        hint: "Sent verbatim to the endpoint (e.g. synthetic/hf:nvidia/Kimi-K2.5-NVFP4)",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        required: true,
        hint: "Absolute endpoint URL (e.g. http://127.0.0.1:8317/v1)",
      },
      {
        key: "transport",
        label: "Transport",
        type: "select",
        required: true,
        options: [
          { value: "openai_chat_completions", label: "OpenAI Chat Completions" },
          { value: "anthropic_messages", label: "Anthropic Messages" },
        ],
        hint: "API format used by the endpoint",
      },
      {
        key: "apiKeyEnv",
        label: "API Key Env Var",
        type: "text",
        hint: "Name of the environment variable holding the API key (e.g. CLIPROXY_API_KEY)",
      },
      {
        key: "modelAlias",
        label: "Model Alias",
        type: "text",
        hint: "Optional display/canonical model ID stored in run records",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions File Path",
        type: "text",
        hint: "Absolute path to AGENTS.md injected as system instructions",
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
        hint: "Wait after timeout before hard abort",
      },
    ],
  };
}
