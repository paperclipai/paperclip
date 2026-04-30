import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  DEFAULT_OLLAMA_KEEP_ALIVE_SEC,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC,
  DEFAULT_OLLAMA_TEMPERATURE,
  DEFAULT_OLLAMA_TOP_P,
} from "../constants.js";

export interface ResolvedOllamaConfig {
  baseUrl: string;
  model: string;
  contextWindow: number;
  keepAliveSec: number;
  requestTimeoutSec: number;
  maxOutputTokens: number | null;
  temperature: number;
  topP: number;
  instructionsFilePath: string;
  promptTemplate: string;
}

const PROMPT_TEMPLATE_FALLBACK =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.";

export function resolveOllamaConfig(rawConfig: unknown): ResolvedOllamaConfig {
  const config = parseObject(rawConfig);
  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_BASE_URL).trim() || DEFAULT_OLLAMA_BASE_URL;
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const contextWindow = clampPositive(asNumber(config.contextWindow, DEFAULT_OLLAMA_CONTEXT_WINDOW), DEFAULT_OLLAMA_CONTEXT_WINDOW);
  const keepAliveSec = clampPositive(asNumber(config.keepAliveSec, DEFAULT_OLLAMA_KEEP_ALIVE_SEC), DEFAULT_OLLAMA_KEEP_ALIVE_SEC);
  const requestTimeoutSec = clampPositive(asNumber(config.requestTimeoutSec, DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC), DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC);
  const maxOutputTokensRaw = asNumber(config.maxOutputTokens, 0);
  const maxOutputTokens = maxOutputTokensRaw > 0 ? Math.floor(maxOutputTokensRaw) : null;
  const temperature = clampBetween(asNumber(config.temperature, DEFAULT_OLLAMA_TEMPERATURE), 0, 2, DEFAULT_OLLAMA_TEMPERATURE);
  const topP = clampBetween(asNumber(config.topP, DEFAULT_OLLAMA_TOP_P), 0, 1, DEFAULT_OLLAMA_TOP_P);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const promptTemplate = asString(config.promptTemplate, PROMPT_TEMPLATE_FALLBACK);

  return {
    baseUrl,
    model,
    contextWindow,
    keepAliveSec,
    requestTimeoutSec,
    maxOutputTokens,
    temperature,
    topP,
    instructionsFilePath,
    promptTemplate,
  };
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function clampBetween(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function getOllamaConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Ollama base URL",
        type: "text",
        default: DEFAULT_OLLAMA_BASE_URL,
        hint: "Where the local Ollama HTTP server is listening. Local-only in v1.",
        required: false,
        group: "connection",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_OLLAMA_MODEL,
        hint: "Model tag as shown by `ollama list` (e.g. llama3.1:8b).",
        required: true,
        group: "model",
      },
      {
        key: "contextWindow",
        label: "Context window (num_ctx)",
        type: "number",
        default: DEFAULT_OLLAMA_CONTEXT_WINDOW,
        hint: "Ollama will silently truncate prompts past this size. v1 emits a warning on truncation.",
        group: "model",
      },
      {
        key: "keepAliveSec",
        label: "Keep-alive (seconds)",
        type: "number",
        default: DEFAULT_OLLAMA_KEEP_ALIVE_SEC,
        hint: "How long Ollama keeps the model resident after the last request.",
        group: "model",
      },
      {
        key: "requestTimeoutSec",
        label: "Request timeout (seconds)",
        type: "number",
        default: DEFAULT_OLLAMA_REQUEST_TIMEOUT_SEC,
        hint: "Hard timeout per /api/chat request.",
        group: "connection",
      },
      {
        key: "maxOutputTokens",
        label: "Max output tokens (num_predict)",
        type: "number",
        default: 0,
        hint: "Set to 0 to use Ollama's default.",
        group: "model",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: DEFAULT_OLLAMA_TEMPERATURE,
        hint: "Sampling temperature (0–2).",
        group: "model",
      },
      {
        key: "topP",
        label: "Top-p",
        type: "number",
        default: DEFAULT_OLLAMA_TOP_P,
        hint: "Nucleus sampling threshold (0–1).",
        group: "model",
      },
      {
        key: "instructionsFilePath",
        label: "Agent instructions file",
        type: "text",
        default: "",
        hint: "Absolute path to a markdown file prepended as the system message.",
        group: "prompt",
      },
    ],
  };
}
