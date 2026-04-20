import { spawnSync } from "node:child_process";
import { models as kiroFallbackModels } from "@paperclipai/adapter-kiro-local";
import type { AdapterModel } from "./types.js";

const KIRO_MODELS_TIMEOUT_MS = 5_000;
const KIRO_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

interface KiroModelEntry {
  model_id?: string;
  model_name?: string;
  description?: string;
  rate_multiplier?: number;
  rate_unit?: string;
  context_window_tokens?: number;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(tokens / 1000)}K ctx`;
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "deepseek-3.2": "DeepSeek V3.2",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.1": "MiniMax M2.1",
  "glm-5": "GLM-5",
  "qwen3-coder-next": "Qwen3 Coder Next",
};

function titleCaseModelId(id: string): string {
  if (MODEL_DISPLAY_NAMES[id]) return MODEL_DISPLAY_NAMES[id];
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function formatModelLabel(entry: KiroModelEntry): string {
  const id = (entry.model_id ?? entry.model_name ?? "").trim();
  if (!id) return "";

  const name = titleCaseModelId(id);
  const parts: string[] = [];
  const ctx = typeof entry.context_window_tokens === "number" ? entry.context_window_tokens : 0;
  if (ctx > 0) parts.push(formatContextWindow(ctx));
  const rate = typeof entry.rate_multiplier === "number" ? entry.rate_multiplier : null;
  if (rate !== null) parts.push(`${rate.toFixed(2)}x`);
  const desc = typeof entry.description === "string" ? entry.description : "";
  if (/experimental|preview/i.test(desc)) parts.push("experimental");

  return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
}

function parseKiroModelsJson(stdout: string): AdapterModel[] {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(trimmed) as { models?: unknown; default_model?: string };
    const entries = Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
    const models: AdapterModel[] = [];
    for (const item of entries) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as KiroModelEntry;
      const id = entry.model_id ?? entry.model_name;
      if (typeof id !== "string" || !id.trim()) continue;
      if (id.trim() === "auto") continue;
      const label = formatModelLabel(entry);
      models.push({ id: id.trim(), label: label || id.trim() });
    }
    return dedupeModels(models);
  } catch {
    return [];
  }
}

function fetchKiroModelsFromCli(): AdapterModel[] {
  const result = spawnSync("kiro-cli", ["chat", "--list-models", "--format", "json"], {
    encoding: "utf8",
    timeout: KIRO_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.error || (result.status ?? 1) !== 0) return [];
  return parseKiroModelsJson(typeof result.stdout === "string" ? result.stdout : "");
}

export async function listKiroModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const discovered = fetchKiroModelsFromCli();
  if (discovered.length > 0) {
    cached = { expiresAt: now + KIRO_MODELS_CACHE_TTL_MS, models: discovered };
    return discovered;
  }

  if (cached && cached.models.length > 0) return cached.models;
  return dedupeModels(kiroFallbackModels);
}

export function resetKiroModelsCacheForTests() {
  cached = null;
}
