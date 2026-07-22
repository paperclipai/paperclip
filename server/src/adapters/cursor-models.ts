import { spawnSync } from "node:child_process";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import type { AdapterModel } from "./types.js";

const CURSOR_MODELS_TIMEOUT_MS = 5_000;
const CURSOR_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

type CursorModelsCommandResult = {
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

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(.*\)\s*$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const value = sanitizeModelId(raw);
  if (!value) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function pushModelId(target: AdapterModel[], raw: string) {
  const id = sanitizeModelId(raw);
  if (!isLikelyModelId(id)) return;
  target.push({ id, label: id });
}

function collectFromJsonValue(value: unknown, target: AdapterModel[]) {
  if (typeof value === "string") {
    pushModelId(target, value);
    return;
  }
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item === "string") {
      pushModelId(target, item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string") {
      pushModelId(target, id);
    }
  }
}

export function parseCursorModelsOutput(stdout: string, stderr: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  const combined = `${stdout}\n${stderr}`;

  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedStdout) as unknown;
      if (Array.isArray(parsed)) {
        collectFromJsonValue(parsed, models);
      } else if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        collectFromJsonValue(rec.models, models);
        collectFromJsonValue(rec.data, models);
      }
    } catch {
      // Ignore malformed JSON and continue parsing plain text formats.
    }
  }

  for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
    const list = match[1] ?? "";
    for (const token of list.split(",")) {
      pushModelId(models, token);
    }
  }

  for (const lineRaw of combined.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const bullet = line.replace(/^[-*]\s+/, "").trim();
    if (!bullet || bullet.includes(" ")) continue;
    pushModelId(models, bullet);
  }

  return dedupeModels(models);
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([...models, ...cursorFallbackModels]);
}

function defaultCursorModelsRunner(): CursorModelsCommandResult {
  const result = spawnSync("agent", ["models"], {
    encoding: "utf8",
    timeout: CURSOR_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let cursorModelsRunner: () => CursorModelsCommandResult = defaultCursorModelsRunner;

function fetchCursorModelsFromCli(): AdapterModel[] {
  const result = cursorModelsRunner();
  const { stdout, stderr } = result;
  if (result.hasError && stdout.trim().length === 0 && stderr.trim().length === 0) {
    return [];
  }
  if ((result.status ?? 1) !== 0 && !/available models?:/i.test(`${stdout}\n${stderr}`)) {
    return [];
  }

  return parseCursorModelsOutput(stdout, stderr);
}

export async function listCursorModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = fetchCursorModelsFromCli();
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = {
      expiresAt: now + CURSOR_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(cursorFallbackModels);
}

export function resetCursorModelsCacheForTests() {
  cached = null;
}

export function setCursorModelsRunnerForTests(runner: (() => CursorModelsCommandResult) | null) {
  cursorModelsRunner = runner ?? defaultCursorModelsRunner;
}
