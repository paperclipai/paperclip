import { asBoolean, asNumber, asString, asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { ZaiMessage, ZaiToolDefinition } from "./types.js";
import { DEFAULT_ZAI_BASE_URL, DEFAULT_ZAI_MODEL } from "../index.js";

export interface ResolvedZaiConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number;
  systemPrompt: string | null;
  stream: boolean;
  responseFormat: "text" | "json_object" | null;
  tools: ZaiToolDefinition[];
  extraMessages: ZaiMessage[];
}

export const DEFAULT_TIMEOUT_MS = 60_000;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_ZAI_BASE_URL;
}

function normalizeTools(value: unknown): ZaiToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: ZaiToolDefinition[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn = parseObject(record.function);
    const name = nonEmpty(fn.name);
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        ...(nonEmpty(fn.description) ? { description: nonEmpty(fn.description)! } : {}),
        ...(typeof fn.parameters === "object" && fn.parameters !== null
          ? { parameters: fn.parameters as Record<string, unknown> }
          : {}),
      },
    });
  }
  return out;
}

function normalizeExtraMessages(value: unknown): ZaiMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ZaiMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const role = nonEmpty(record.role);
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const content =
      typeof record.content === "string"
        ? record.content
        : record.content == null
          ? ""
          : JSON.stringify(record.content);
    out.push({
      role,
      content,
      ...(nonEmpty(record.name) ? { name: nonEmpty(record.name)! } : {}),
      ...(nonEmpty(record.tool_call_id) ? { tool_call_id: nonEmpty(record.tool_call_id)! } : {}),
    });
  }
  return out;
}

function normalizeResponseFormat(value: unknown): "text" | "json_object" | null {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === "json" || normalized === "json_object") return "json_object";
  if (normalized === "text") return "text";
  return null;
}

export function resolveZaiConfig(input: Record<string, unknown>): ResolvedZaiConfig {
  const config = parseObject(input);
  const apiKey =
    nonEmpty(config.apiKey) ??
    nonEmpty(config.api_key) ??
    nonEmpty(process.env.ZAI_API_KEY);

  const baseUrlRaw =
    nonEmpty(config.baseUrl) ??
    nonEmpty(config.base_url) ??
    nonEmpty(process.env.ZAI_BASE_URL) ??
    DEFAULT_ZAI_BASE_URL;

  const model = nonEmpty(config.model) ?? DEFAULT_ZAI_MODEL;
  const temperature =
    typeof config.temperature === "number" && Number.isFinite(config.temperature)
      ? config.temperature
      : null;
  const maxTokens =
    typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
      ? Math.max(1, Math.floor(config.maxTokens))
      : null;
  const timeoutMs = Math.max(1_000, asNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS));
  const systemPrompt = nonEmpty(config.systemPrompt);
  const stream = asBoolean(config.stream, true);
  const responseFormat = normalizeResponseFormat(config.responseFormat);
  const tools = normalizeTools(config.tools);
  const extraMessages = normalizeExtraMessages(config.messages);

  // Suppress unused-import warning when asString/asStringArray aren't referenced
  void asString;
  void asStringArray;

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    model,
    temperature,
    maxTokens,
    timeoutMs,
    systemPrompt,
    stream,
    responseFormat,
    tools,
    extraMessages,
  };
}
