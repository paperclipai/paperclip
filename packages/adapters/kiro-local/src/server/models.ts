import { spawnSync } from "node:child_process";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models } from "../index.js";

const KIRO_MODELS_TIMEOUT_MS = 5_000;
const KIRO_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

/**
 * Static fallback list, derived from the adapter's canonical model array.
 */
export const KIRO_MODELS: AdapterModel[] = [...models];

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

type KiroModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

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

export function parseKiroModelsOutput(stdout: string): AdapterModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    // Array of strings: ["auto", "claude-opus-4.6", ...]
    if (Array.isArray(parsed)) {
      const models: AdapterModel[] = [];
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          const id = item.trim();
          models.push({ id, label: id });
        } else if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const id = typeof rec.id === "string" ? rec.id.trim() : "";
          if (!id) continue;
          const label = typeof rec.label === "string" ? rec.label.trim() : id;
          models.push({ id, label });
        }
      }
      return dedupeModels(models);
    }

    // Object with a models/data field
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      const arr = rec.models ?? rec.data;
      if (Array.isArray(arr)) {
        return parseKiroModelsOutput(JSON.stringify(arr));
      }
    }
  } catch {
    // Not JSON — ignore
  }

  return [];
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([...models, ...KIRO_MODELS]);
}

function defaultKiroModelsRunner(): KiroModelsCommandResult {
  const result = spawnSync("kiro-cli", ["chat", "--list-models", "--format", "json"], {
    encoding: "utf8",
    timeout: KIRO_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let kiroModelsRunner: () => KiroModelsCommandResult = defaultKiroModelsRunner;

function fetchKiroModelsFromCli(): AdapterModel[] {
  const result = kiroModelsRunner();
  if (result.hasError || (result.status ?? 1) !== 0) {
    return [];
  }
  return parseKiroModelsOutput(result.stdout);
}

/**
 * List available kiro-cli models with dynamic discovery.
 *
 * Calls `kiro-cli chat --list-models --format json` and caches the result
 * for 60 seconds. Falls back to the static model list if the command fails.
 */
export async function listKiroModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = fetchKiroModelsFromCli();
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = {
      expiresAt: now + KIRO_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  // CLI failed — return stale cache if available, otherwise static fallback
  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(KIRO_MODELS);
}

export function resetKiroModelsCacheForTests() {
  cached = null;
}

export function setKiroModelsRunnerForTests(runner: (() => KiroModelsCommandResult) | null) {
  kiroModelsRunner = runner ?? defaultKiroModelsRunner;
}
