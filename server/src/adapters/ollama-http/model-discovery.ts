import type { AdapterModel } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";

export type OllamaTagEntry = {
  name: string;
  model: string;
};

export type OllamaHttpModelPreference = "coding" | "general";

const CODING_ROLES = new Set(["engineer", "qa", "devops", "security", "cto"]);
const CODING_MODEL_HINTS = [
  "qwen3-coder",
  "qwen2.5-coder",
  "deepseek-coder",
  "codestral",
  "devstral",
  "codellama",
  "codegemma",
  "starcoder",
  "coder",
  "-code",
  "code-",
  "gpt-oss",
] as const;
const GENERAL_MODEL_HINTS = [
  "qwen3",
  "deepseek-r1",
  "qwq",
  "llama3.3",
  "llama3.2",
  "llama3.1",
  "gemma3",
  "mistral",
  "phi4",
  "instruct",
  "chat",
] as const;
const RESPONSIVE_MODEL_HINTS = [
  "flash",
  "turbo",
  "mini",
  "small",
  "medium",
  "next",
  "fast",
  "lite",
] as const;
const EXCLUDED_MODEL_HINTS = [
  "embed",
  "embedding",
  "whisper",
  "tts",
  "transcribe",
  "rerank",
  "bge",
  "nomic-embed",
  "stt",
] as const;
const MODEL_SIZE_RE = /(\d+(?:\.\d+)?)b\b/i;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https:\/[^/]/i.test(trimmed)) {
    return trimmed.replace(/^https:\//i, "https://");
  }
  if (/^http:\/[^/]/i.test(trimmed)) {
    return trimmed.replace(/^http:\//i, "http://");
  }
  return trimmed;
}

export function resolveOllamaHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(normalizeBaseUrl(value));
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http:// or https://.`);
  }

  return parsed;
}

export function parseOllamaHttpHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

export function readOllamaHttpAgentRole(agent: { role?: unknown } | null | undefined): string | null {
  return asString(agent?.role, "").trim() || null;
}

export function readOllamaHttpModelPreference(input: {
  config: Record<string, unknown>;
  agentRole: string | null;
}): OllamaHttpModelPreference {
  const explicit = asString(input.config.modelPreference, "").trim().toLowerCase();
  if (explicit === "general") return "general";
  if (explicit === "coding") return "coding";
  return CODING_ROLES.has((input.agentRole ?? "").trim().toLowerCase()) ? "coding" : "general";
}

function readModelSizeScore(modelId: string): number {
  const match = modelId.match(MODEL_SIZE_RE);
  if (!match) return 0;
  const parsed = Number.parseFloat(match[1] ?? "0");
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;

  if (parsed <= 4) return -30;
  if (parsed <= 8) return -12;
  if (parsed <= 16) return 10;
  if (parsed <= 40) return 32;
  if (parsed <= 80) return 18;
  if (parsed <= 120) return 0;
  if (parsed <= 180) return -30;
  if (parsed <= 300) return -70;
  return -110;
}

function scoreModel(modelId: string, preference: OllamaHttpModelPreference): number {
  const lower = modelId.toLowerCase();
  if (EXCLUDED_MODEL_HINTS.some((hint) => lower.includes(hint))) {
    return -10_000;
  }

  let score = readModelSizeScore(lower);
  if (lower.includes(":latest")) score += 10;
  if (lower.includes(":cloud")) score += 12;
  if (lower.includes("instruct")) score += 8;
  RESPONSIVE_MODEL_HINTS.forEach((hint, index) => {
    if (lower.includes(hint)) score += 64 - (index * 4);
  });

  if (preference === "coding") {
    CODING_MODEL_HINTS.forEach((hint, index) => {
      if (lower.includes(hint)) score += 250 - (index * 12);
    });
    GENERAL_MODEL_HINTS.forEach((hint, index) => {
      if (lower.includes(hint)) score += 80 - (index * 4);
    });
  } else {
    GENERAL_MODEL_HINTS.forEach((hint, index) => {
      if (lower.includes(hint)) score += 220 - (index * 10);
    });
    CODING_MODEL_HINTS.forEach((hint, index) => {
      if (lower.includes(hint)) score -= Math.max(10, 36 - (index * 2));
    });
  }

  return score;
}

export function parseOllamaTagEntries(payload: unknown): OllamaTagEntry[] {
  const parsed = parseObject(payload);
  const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
  const out: OllamaTagEntry[] = [];
  const seen = new Set<string>();

  for (const rawEntry of rawModels) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const name = asString(entry.name, "").trim();
    const model = asString(entry.model, name).trim();
    const id = name || model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ name: id, model: model || id });
  }

  return out;
}

export function chooseBestOllamaModel(
  models: OllamaTagEntry[],
  preference: OllamaHttpModelPreference,
): OllamaTagEntry | null {
  return rankOllamaModels(models, preference)[0] ?? null;
}

export function rankOllamaModels(
  models: OllamaTagEntry[],
  preference: OllamaHttpModelPreference,
): OllamaTagEntry[] {
  return [...models]
    .map((entry) => ({
      entry,
      score: scoreModel(entry.name || entry.model, preference),
    }))
    .filter((entry) => entry.score > -10_000)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (left.entry.name || left.entry.model).localeCompare(right.entry.name || right.entry.model, "en", {
        sensitivity: "base",
        numeric: true,
      });
    })
    .map((entry) => entry.entry);
}

export async function fetchOllamaJson(input: {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | null;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = input.timeoutMs > 0 ? setTimeout(() => controller.abort(), input.timeoutMs) : null;
  try {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: input.body
        ? {
            accept: "application/json",
            "content-type": "application/json",
            ...(input.headers ?? {}),
          }
        : {
            accept: "application/json",
            ...(input.headers ?? {}),
          },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let json: unknown = null;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request to ${input.url.toString()} timed out after ${input.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveOllamaHttpDiscoveryConfig(
  config: Record<string, unknown>,
  options: { agentRole?: string | null } = {},
) {
  const baseUrlInput = asString(config.baseUrl, asString(config.url, "")).trim();
  if (!baseUrlInput) {
    throw new Error("Ollama HTTP adapter requires adapterConfig.baseUrl (or url).");
  }

  const baseUrl = resolveOllamaHttpUrl(baseUrlInput, "Ollama baseUrl");
  const timeoutSec = Math.max(0, asNumber(config.timeoutSec, 0));
  const timeoutMs = Math.max(0, asNumber(config.timeoutMs, timeoutSec > 0 ? timeoutSec * 1000 : 0));
  const headers = parseOllamaHttpHeaders(config.headers);
  const modelPreference = readOllamaHttpModelPreference({
    config,
    agentRole: options.agentRole ?? null,
  });
  const tagsUrl = resolveOllamaHttpUrl(
    asString(config.tagsUrl, new URL("/api/tags", baseUrl).toString()),
    "Ollama tagsUrl",
  );
  const chatUrl = resolveOllamaHttpUrl(
    asString(config.chatUrl, new URL("/api/chat", baseUrl).toString()),
    "Ollama chatUrl",
  );
  const explicitModel = asString(config.model, "").trim();

  return {
    baseUrl,
    chatUrl,
    explicitModel,
    headers,
    modelPreference,
    tagsUrl,
    timeoutMs,
  };
}

export async function listOllamaHttpModels(
  config: Record<string, unknown>,
  options: { agentRole?: string | null } = {},
): Promise<AdapterModel[]> {
  const { headers, tagsUrl, timeoutMs } = resolveOllamaHttpDiscoveryConfig(config, options);
  const tagsResponse = await fetchOllamaJson({
    url: tagsUrl,
    headers,
    timeoutMs,
  });
  if (!tagsResponse.ok) {
    throw new Error(`Ollama model discovery failed with HTTP ${tagsResponse.status}.`);
  }

  return parseOllamaTagEntries(tagsResponse.json).map((entry) => {
    const id = entry.name || entry.model;
    return { id, label: id } satisfies AdapterModel;
  });
}

export async function detectOllamaHttpModel(
  config: Record<string, unknown>,
  options: { agentRole?: string | null } = {},
): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates: string[];
} | null> {
  const discovery = resolveOllamaHttpDiscoveryConfig(config, options);
  if (discovery.explicitModel && discovery.explicitModel.toLowerCase() !== "auto") {
    return {
      model: discovery.explicitModel,
      provider: "ollama",
      source: "adapterConfig.model",
      candidates: [discovery.explicitModel],
    };
  }

  const models = await listOllamaHttpModels(config, options);
  const chosen = chooseBestOllamaModel(
    models.map((model) => ({ name: model.id, model: model.id })),
    discovery.modelPreference,
  );
  if (!chosen) return null;

  return {
    model: chosen.name || chosen.model,
    provider: "ollama",
    source: "api/tags",
    candidates: models.map((model) => model.id),
  };
}
