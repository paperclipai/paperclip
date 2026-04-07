import type { AdapterModel } from "./types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MODELS_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;

let cached: { baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

/**
 * Parse model.base_url from raw Hermes config YAML.
 * Uses simple line parsing to avoid a YAML dependency (same approach as
 * hermes-paperclip-adapter's detect-model).
 */
function parseBaseUrlFromConfig(content: string): string | null {
  const lines = content.split("\n");
  let inModelSection = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      continue;
    }

    // Left the model section when indent drops back to 0
    if (inModelSection && indent === 0 && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*base_url\s*:\s*(.+)$/);
      if (match) {
        return match[1].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return null;
}

async function readHermesBaseUrl(): Promise<string | null> {
  const filePath = join(homedir(), ".hermes", "config.yaml");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return parseBaseUrlFromConfig(content);
}

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

async function fetchModels(baseUrl: string): Promise<AdapterModel[]> {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/models";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  const baseUrl = await readHermesBaseUrl();
  if (!baseUrl) return [];

  const now = Date.now();
  if (cached && cached.baseUrl === baseUrl && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchModels(baseUrl);
  if (fetched.length > 0) {
    const sorted = fetched.sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
    );
    cached = { baseUrl, expiresAt: now + MODELS_CACHE_TTL_MS, models: sorted };
    return sorted;
  }

  // Return stale cache if fresh fetch failed
  if (cached && cached.baseUrl === baseUrl && cached.models.length > 0) {
    return cached.models;
  }

  return [];
}
