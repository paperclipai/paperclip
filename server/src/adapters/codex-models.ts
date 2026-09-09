import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import {
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
} from "@paperclipai/adapter-codex-local/server";
import { readConfigFile } from "../config-file.js";

const CODEX_MODELS_CACHE_FILENAME = "models_cache.json";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
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

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...codexFallbackModels,
  ]).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

/**
 * Candidate `CODEX_HOME` directories to look for a Codex-maintained
 * `models_cache.json` in, most specific first.
 *
 * Paperclip launches `codex_local` agents against a company-scoped managed
 * home (`resolveManagedCodexHomeDir`), not the process-wide shared home
 * (`resolveSharedCodexHomeDir`) that only reflects whatever account last ran
 * `codex` on this host directly. When a `companyId` is available (i.e. we are
 * serving a request scoped to a company), that managed home is what the
 * company's agents actually populate, so it must be checked first; the shared
 * home remains the fallback for hosts without company-scoped runs (e.g.
 * single-tenant/dev setups) or before a company has ever run Codex.
 */
function candidateCodexHomeDirs(companyId?: string): string[] {
  const dirs = [resolveSharedCodexHomeDir()];
  if (companyId) {
    dirs.unshift(resolveManagedCodexHomeDir(process.env, companyId));
  }
  return dirs;
}

function parseCodexModelsCachePayload(raw: string): AdapterModel[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const entries = (payload as { models?: unknown }).models;
  if (!Array.isArray(entries)) return null;

  const models: AdapterModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { slug, display_name: displayName, visibility } = entry as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
    };
    if (typeof slug !== "string" || slug.trim().length === 0) continue;
    // Codex keeps internal slugs (`gpt-reserve`, `codex-auto-review`) out of its own picker with
    // visibility "hide"; mirror that instead of advertising models users are not meant to pick.
    if (visibility !== "list") continue;
    const id = slug.trim();
    const label = typeof displayName === "string" && displayName.trim().length > 0
      ? displayName.trim()
      : id;
    models.push({ id, label });
  }

  return dedupeModels(models);
}

/**
 * Read the model catalog the Codex CLI maintains for itself.
 *
 * Codex refreshes `$CODEX_HOME/models_cache.json` from the ChatGPT backend during normal use, so it
 * is the only discovery source that works for ChatGPT-authenticated installs — which have no
 * `OPENAI_API_KEY`, making the OpenAI API path below a silent no-op for them.
 *
 * Tries each candidate home in order (see {@link candidateCodexHomeDirs}) and returns the first
 * one whose cache file exists and parses, so a company-scoped managed home wins over the shared
 * host default when both are available. Returns `[]` when every candidate hits a failure mode
 * (missing file, unreadable, malformed JSON, unexpected shape) so callers fall through to the
 * existing API and static-fallback paths.
 */
async function readCodexModelsCache(companyId?: string): Promise<AdapterModel[]> {
  for (const homeDir of candidateCodexHomeDirs(companyId)) {
    let raw: string;
    try {
      raw = await readFile(path.join(homeDir, CODEX_MODELS_CACHE_FILENAME), "utf8");
    } catch {
      continue;
    }

    const models = parseCodexModelsCachePayload(raw);
    if (models !== null) return models;
  }

  return [];
}

async function fetchOpenAiModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
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

async function loadCodexModels(
  companyId?: string,
  options?: { forceRefresh?: boolean },
): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const fallback = dedupeModels(codexFallbackModels);

  // Codex's own cache wins when present: it reflects what this install can actually run today,
  // including models newer than any Paperclip release. It is a cheap local file that Codex owns
  // refreshing, so it is re-read on every call rather than memoized behind the TTL below.
  const codexCachedModels = await readCodexModelsCache(companyId);
  if (codexCachedModels.length > 0) return mergedWithFallback(codexCachedModels);

  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchOpenAiModels(apiKey);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      expiresAt: now + OPENAI_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export async function listCodexModels(companyId?: string): Promise<AdapterModel[]> {
  return loadCodexModels(companyId);
}

export async function refreshCodexModels(companyId?: string): Promise<AdapterModel[]> {
  return loadCodexModels(companyId, { forceRefresh: true });
}

export function resetCodexModelsCacheForTests() {
  cached = null;
}
