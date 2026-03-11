import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

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

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function defaultSettingsPath(): string {
  const home =
    (typeof process.env.HOME === "string" && process.env.HOME.trim()) ||
    os.homedir();
  return path.join(home, ".qwen", "settings.json");
}

function resolveSettingsPath(input: unknown): string {
  const explicit =
    asString(input, "").trim() ||
    asString(process.env.PAPERCLIP_QWEN_SETTINGS_PATH, "").trim() ||
    asString(process.env.QWEN_SETTINGS_PATH, "").trim();
  return explicit || defaultSettingsPath();
}

function getSelectedAuthType(record: Record<string, unknown>): string | null {
  const security = parseObject(record.security);
  const auth = parseObject(security.auth);
  const selectedType = asString(auth.selectedType, "").trim();
  return selectedType || null;
}

function readProviders(record: Record<string, unknown>, authType: string | null): AdapterModel[] {
  const providers = parseObject(record.modelProviders);
  const selected = authType ? parseProviderEntries(providers[authType]) : [];
  if (selected.length > 0) return selected;

  const all: AdapterModel[] = [];
  for (const value of Object.values(providers)) {
    all.push(...parseProviderEntries(value));
  }
  return all;
}

function parseProviderEntries(value: unknown): AdapterModel[] {
  if (!Array.isArray(value)) return [];
  const models: AdapterModel[] = [];
  for (const entry of value) {
    const record = parseObject(entry);
    const id = asString(record.id, "").trim();
    if (!id) continue;
    // Qwen provider display names often prepend billing/provider metadata.
    // Keep the UI concise by showing the model id as the label.
    models.push({ id, label: id });
  }
  return models;
}

export async function discoverQwenModels(input: {
  settingsPath?: unknown;
} = {}): Promise<AdapterModel[]> {
  const settingsPath = resolveSettingsPath(input.settingsPath);
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Qwen settings file not found: ${settingsPath}. Configure Qwen Code before loading models.`,
      );
    }
    throw err;
  }
  const parsed = parseJson(raw);
  if (!parsed) {
    throw new Error(`Failed to parse Qwen settings JSON: ${settingsPath}`);
  }

  const record = parseObject(parsed);
  const authType = getSelectedAuthType(record);
  const discovered = readProviders(record, authType);
  return sortModels(dedupeModels(discovered));
}

export async function discoverQwenModelsCached(input: {
  settingsPath?: unknown;
} = {}): Promise<AdapterModel[]> {
  const settingsPath = resolveSettingsPath(input.settingsPath);
  const now = Date.now();
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }

  const cached = discoveryCache.get(settingsPath);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverQwenModels({ settingsPath });
  discoveryCache.set(settingsPath, {
    expiresAt: now + MODELS_CACHE_TTL_MS,
    models,
  });
  return models;
}

export async function listQwenModels(): Promise<AdapterModel[]> {
  try {
    return await discoverQwenModelsCached();
  } catch {
    return [];
  }
}

export function resetQwenModelsCacheForTests() {
  discoveryCache.clear();
}
