import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

export function requireOpenCodeModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidOpenCodeModelId(model)) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }
  return model;
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

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function parseOpenCodeModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

// ── Persistent disk cache ──────────────────────────────────────────────────

interface DiskCacheEntry {
  models: AdapterModel[];
  discoveredAt: number;
}

function diskCacheDir(): string {
  return process.env.PAPERCLIP_OPENCODE_MODELS_CACHE_DIR || os.tmpdir();
}

function diskCacheFilePath(key: string): string {
  const keyHash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(diskCacheDir(), `paperclip-opencode-models-${keyHash}.json`);
}

async function readDiskCache(filePath: string): Promise<DiskCacheEntry | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as DiskCacheEntry).models) ||
      typeof (parsed as DiskCacheEntry).discoveredAt !== "number"
    ) {
      return null;
    }
    return parsed as DiskCacheEntry;
  } catch {
    return null;
  }
}

async function writeDiskCache(filePath: string, models: AdapterModel[]): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify({ models, discoveredAt: Date.now() }), "utf8");
  } catch {
    // Best-effort write; disk cache is opportunistic
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  // Prevent OpenCode from writing an opencode.json into the working directory.
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}), OPENCODE_DISABLE_PROJECT_CONFIG: "true" }));

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseOpenCodeModelsOutput(result.stdout));
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export type ModelDiscoverySource = "live" | "disk_cache" | "configured_model";

export interface ModelDiscoveryResult {
  models: AdapterModel[];
  source: ModelDiscoverySource;
  /** Milliseconds since the disk-cache entry was written. Only present when source === "disk_cache". */
  cacheAge?: number;
}

/**
 * Like discoverOpenCodeModelsCached but never throws when a fallback is available.
 *
 * Priority order on probe failure:
 *  1. Persistent on-disk cache (returned even when stale)
 *  2. Configured model trusted as a single-entry list
 *  3. Throw (no fallback, same contract as bare discoverOpenCodeModels)
 */
export async function discoverOpenCodeModelsResilient(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  /** Configured model ID used as last-resort fallback when probe fails and no cache exists. */
  model?: unknown;
} = {}): Promise<ModelDiscoveryResult> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const cachePath = diskCacheFilePath(key);

  // In-memory cache hit — treat as live (same TTL as discoverOpenCodeModelsCached)
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const inMemory = discoveryCache.get(key);
  if (inMemory && inMemory.expiresAt > now) {
    return { models: inMemory.models, source: "live" };
  }

  let probeError: unknown = null;
  try {
    const models = await discoverOpenCodeModels({ command, cwd, env });
    discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
    // Write disk cache best-effort in background
    void writeDiskCache(cachePath, models);
    return { models, source: "live" };
  } catch (err) {
    probeError = err;
  }

  // Probe failed: try persistent disk cache
  const diskEntry = await readDiskCache(cachePath);
  if (diskEntry) {
    const cacheAge = Date.now() - diskEntry.discoveredAt;
    // Promote into in-memory cache so repeated calls don't re-read disk
    discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models: diskEntry.models });
    return { models: diskEntry.models, source: "disk_cache", cacheAge };
  }

  // No disk cache: trust configured model if valid
  const modelStr = asString(input.model, "").trim();
  if (modelStr && isValidOpenCodeModelId(modelStr)) {
    return { models: [{ id: modelStr, label: modelStr }], source: "configured_model" };
  }

  // Nothing to fall back to
  throw probeError instanceof Error ? probeError : new Error(String(probeError));
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that by skipping the availability probe;
  // we still enforce the provider/model format above and do not second-guess
  // the configured model. Prefer the explicit run env, then the process env.
  const env = normalizeEnv(input.env);
  if (isTruthyEnvFlag(env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return [{ id: model, label: model }];
  }

  const result = await discoverOpenCodeModelsResilient({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    model, // last-resort: trust configured model if probe times out and no cache
  });

  const models = result.models;

  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

/** Clears only the in-memory cache. Use in tests that simulate a process restart (disk persists). */
export function resetOpenCodeModelsMemoryCacheForTests() {
  discoveryCache.clear();
}

/** Full reset: clears in-memory cache AND any disk cache files in the test cache dir. */
export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
  // When a test-specific cache dir is set, synchronously remove all cache files so
  // each test starts with a clean disk state.
  const testCacheDir = process.env.PAPERCLIP_OPENCODE_MODELS_CACHE_DIR;
  if (testCacheDir) {
    try {
      for (const file of readdirSync(testCacheDir)) {
        if (file.startsWith("paperclip-opencode-models-") && file.endsWith(".json")) {
          try { unlinkSync(path.join(testCacheDir, file)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  }
}

export async function populateOpenCodeModelsDiskCacheForTests(
  input: { command?: unknown; cwd?: unknown; env?: unknown },
  models: AdapterModel[],
): Promise<void> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  await writeDiskCache(diskCacheFilePath(key), models);
}

export { DISK_CACHE_TTL_MS };
