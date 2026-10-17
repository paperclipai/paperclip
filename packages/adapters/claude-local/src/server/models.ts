import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  claudeModelCatalogSchema,
  type ClaudeModelCatalog,
} from "@paperclipai/shared/claude-model-catalog";
import { resolveDefaultModelCatalogDir } from "@paperclipai/shared/home-paths";
import { claudeLocalReasoningEffortsForModel } from "../index.js";
import { parseClaudeModelId, sameClaudeModelRelease } from "../model-id.js";
import { DEFAULT_CLAUDE_MODEL_CATALOG } from "../model-catalog.default.js";
import { sortClaudeModels } from "./model-order.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";
const MODEL_CATALOG_OVERRIDE_FILENAME = "claude.json";

// Caches only the raw Anthropic-discovered id/label list; the catalog is merged in fresh on
// every call so an on-disk catalog edit is reflected immediately, not after the TTL expires.
let discoveryCache: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;
type CatalogCacheEntry =
  | { path: string; mtimeMs: number; kind: "parsed"; catalog: ClaudeModelCatalog }
  | { path: string; mtimeMs: number; kind: "invalid" };
let catalogCache: CatalogCacheEntry | null = null;

function resolveModelCatalogOverridePath(): string {
  const configured = process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDefaultModelCatalogDir(), MODEL_CATALOG_OVERRIDE_FILENAME);
}

/**
 * Load the operator's on-disk model catalog override, if present and valid.
 * Cached by (path, mtime) so a repeated model-list fetch re-reads the file
 * only when it actually changed — no restart required to pick up an edit.
 * Falls back to the bundled default on any missing/invalid file, so a bad
 * manual edit never blocks model discovery or crashes the adapter.
 */
function loadModelCatalog(): ClaudeModelCatalog {
  const overridePath = resolveModelCatalogOverridePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(overridePath);
  } catch {
    catalogCache = null;
    return DEFAULT_CLAUDE_MODEL_CATALOG;
  }
  if (catalogCache && catalogCache.path === overridePath && catalogCache.mtimeMs === stat.mtimeMs) {
    return catalogCache.kind === "parsed" ? catalogCache.catalog : DEFAULT_CLAUDE_MODEL_CATALOG;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(overridePath, "utf8");
  } catch (error) {
    console.warn("[paperclip] Claude model catalog override unreadable, using bundled defaults", {
      path: overridePath,
      error: error instanceof Error ? error.message : String(error),
    });
    // Not cached: a read error (e.g. a permissions problem) doesn't change mtimeMs, so
    // caching it by mtime would keep returning the bundled default even after the
    // underlying problem is fixed. Every lookup retries the read instead.
    return DEFAULT_CLAUDE_MODEL_CATALOG;
  }

  try {
    const parsed = claudeModelCatalogSchema.parse(JSON.parse(raw));
    catalogCache = { path: overridePath, mtimeMs: stat.mtimeMs, kind: "parsed", catalog: parsed };
    return parsed;
  } catch (error) {
    console.warn("[paperclip] Claude model catalog override invalid, using bundled defaults", {
      path: overridePath,
      error: error instanceof Error ? error.message : String(error),
    });
    // Cached by (path, mtime) so a still-malformed file doesn't re-read/re-parse/re-warn on
    // every lookup; it retries only once the file's content (and thus mtime) actually changes.
    catalogCache = { path: overridePath, mtimeMs: stat.mtimeMs, kind: "invalid" };
    return DEFAULT_CLAUDE_MODEL_CATALOG;
  }
}

function toAdapterModels(entries: ClaudeModelCatalog["direct"]): AdapterModel[] {
  return entries.map(({ id, label, efforts }) => (efforts ? { id, label, efforts } : { id, label }));
}

function directCatalogModels(): AdapterModel[] {
  return toAdapterModels(loadModelCatalog().direct);
}

function bedrockCatalogModels(): AdapterModel[] {
  return toAdapterModels(loadModelCatalog().bedrock);
}

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

/**
 * Keeps the first-seen entry per id (so live-discovered labels win), but
 * backfills `efforts` from a later duplicate (the catalog's) when the
 * first-seen entry — typically live discovery, which has no effort data —
 * didn't carry one. This is what lets an operator-granted effort level
 * survive the merge with live Anthropic discovery.
 */
function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const byId = new Map<string, AdapterModel>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      if (existing.efforts === undefined && model.efforts !== undefined) existing.efforts = model.efforts;
      continue;
    }
    const label = model.label.trim() || id;
    byId.set(id, model.efforts ? { id, label, efforts: model.efforts } : { id, label });
  }
  return [...byId.values()];
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  // The Anthropic API returns models in its own order; the picker shows the curated one.
  // Live discovery results are listed first, so dedupeModels keeps live-sourced labels
  // and only the catalog fills in ids discovery did not return.
  return sortClaudeModels(dedupeModels([
    ...models,
    ...directCatalogModels(),
  ]));
}

function resolveAnthropicApiKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function resolveAnthropicBaseUrl(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com";
}

async function fetchAnthropicModels(apiKey: string, baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}`, {
      headers: {
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const displayName =
        typeof record.display_name === "string" && record.display_name.trim().length > 0
          ? record.display_name
          : record.id;
      models.push({
        id: record.id,
        label: displayName,
      });
    }
    return dedupeModels(models);
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return sortClaudeModels(dedupeModels(bedrockCatalogModels()));

  const fallback = sortClaudeModels(dedupeModels(directCatalogModels()));
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl();
  const keyFingerprint = fingerprint(apiKey);
  if (
    options?.forceRefresh !== true &&
    discoveryCache &&
    discoveryCache.keyFingerprint === keyFingerprint &&
    discoveryCache.baseUrl === baseUrl &&
    discoveryCache.expiresAt > now
  ) {
    return mergedWithFallback(discoveryCache.models);
  }

  const fetched = await fetchAnthropicModels(apiKey, baseUrl);
  if (fetched.length > 0) {
    discoveryCache = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS,
      models: fetched,
    };
    return mergedWithFallback(fetched);
  }

  if (
    discoveryCache &&
    discoveryCache.keyFingerprint === keyFingerprint &&
    discoveryCache.baseUrl === baseUrl &&
    discoveryCache.models.length > 0
  ) {
    return mergedWithFallback(discoveryCache.models);
  }

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
}

export function resetClaudeModelsCacheForTests() {
  discoveryCache = null;
  catalogCache = null;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}

/**
 * Server-side counterpart to the client-bundled `claudeLocalReasoningEffortsForModel`
 * that also consults the on-disk catalog override, so a reasoning effort an
 * operator grants a model on disk is enforced the same way it's offered in
 * the picker. Used by server-side validation paths (AI connection pool
 * routing, the public MCP agent-config surface) that run in Node and can
 * read the override synchronously.
 *
 * Looks up the exact catalog id first, so a pinned/dated entry's own
 * `efforts` always win over an earlier, differently-pinned alias of the
 * same release. Only falls back to release-based matching (ignoring
 * snapshot/pin) for an id that isn't itself in the catalog. When the
 * matched entry omits `efforts` (e.g. a bundled Bedrock id, or an override
 * that only relabels a model), falls back to the same bundled-catalog
 * release lookup the picker uses, instead of the generic default, so the
 * two stay in agreement.
 */
export function resolveClaudeReasoningEfforts(model: string): readonly string[] {
  const catalog = loadModelCatalog();
  const pool = isBedrockModelId(model) ? catalog.bedrock : catalog.direct;
  const trimmed = model.trim().toLowerCase();

  const exact = pool.find((entry) => entry.id.trim().toLowerCase() === trimmed);
  if (exact) return exact.efforts ?? claudeLocalReasoningEffortsForModel(model);

  const key = parseClaudeModelId(model);
  if (key) {
    for (const entry of pool) {
      const entryKey = parseClaudeModelId(entry.id);
      if (entryKey && sameClaudeModelRelease(key, entryKey)) {
        return entry.efforts ?? claudeLocalReasoningEffortsForModel(model);
      }
    }
  }
  return claudeLocalReasoningEffortsForModel(model);
}
