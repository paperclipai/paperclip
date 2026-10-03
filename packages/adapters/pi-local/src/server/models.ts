import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 45_000;
const MIN_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_DISCOVERY_TIMEOUT_MS = 300_000;
const DEFAULT_MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_TTL_MS = 3_600_000;
const STALE_RETENTION_MS = 30 * 60_000;
// `pi --list-models` output does not depend on cwd (verified: identical output
// from /tmp and /), so the discovery key intentionally excludes cwd. Callers
// still pass cwd through to the spawned process.

export function resolvePiModelsTimeoutMs(): number {
  return readClampedMsEnv(
    "PAPERCLIP_PI_MODELS_TIMEOUT_MS",
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    MIN_DISCOVERY_TIMEOUT_MS,
    MAX_DISCOVERY_TIMEOUT_MS,
  );
}

export function resolvePiModelsCacheTtlMs(): number {
  const raw = process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_MODELS_CACHE_TTL_MS;
  const parsed = Number(raw);
  // 0 disables caching (single-flight still applies); NaN/negative fall
  // back to the default so a typo can never wedge discovery.
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MODELS_CACHE_TTL_MS;
  return Math.min(Math.floor(parsed), MAX_MODELS_CACHE_TTL_MS);
}

function readClampedMsEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const lines = stdout.split(/\r?\n/);
  
  // Skip header line if present
  let startIndex = 0;
  if (lines.length > 0 && (lines[0].includes("provider") || lines[0].includes("model"))) {
    startIndex = 1;
  }
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse format: "provider   model   context  max-out  thinking  images"
    // Split by 2+ spaces to handle the columnar format
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    
    const provider = parts[0].trim();
    const model = parts[1].trim();
    
    if (!provider || !model) continue;
    if (provider === "provider" && model === "model") continue; // Skip header
    
    const id = `${provider}/${model}`;
    parsed.push({ id, label: id });
  }
  
  return parsed;
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

function resolvePiCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_PI_COMMAND === "string" &&
    process.env.PAPERCLIP_PI_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_PI_COMMAND.trim()
      : "pi";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
// Single-flight: concurrent callers with the same discovery key share one
// in-flight spawn instead of each forking `pi --list-models`. Failures are
// never cached — the entry is removed in `finally` so the next caller
// re-discovers.
const discoveryInFlight = new Map<string, Promise<AdapterModel[]>>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  // Expired entries are retained briefly for opt-in stale fallback
  // (`allowStaleOnFailure`); only ancient ones are dropped to bound memory.
  // Failures are still never written — only successful discoveries land here.
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt + STALE_RETENTION_MS <= now) discoveryCache.delete(key);
  }
}

export async function discoverPiModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const timeoutMs = resolvePiModelsTimeoutMs();
  const result = await runChildProcess(
    `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`pi --list-models` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`pi --list-models\` failed: ${detail}` : "`pi --list-models` failed.");
  }

  // Pi outputs model list to stderr, but fall back to stdout for older versions
  const output = result.stderr || result.stdout;
  return sortModels(dedupeModels(parseModelsOutput(output)));
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

export async function discoverPiModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  /**
   * Opt-in stale fallback: on discovery failure, return the last expired
   * cache entry instead of throwing. Defaults to false (fail-closed).
   * Failures are never written to the cache either way.
   */
  allowStaleOnFailure?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const allowStaleOnFailure = input.allowStaleOnFailure === true;
  const ttlMs = resolvePiModelsCacheTtlMs();
  const key = discoveryCacheKey(command, env);
  const now = Date.now();
  // Snapshot a possibly-expired entry before pruning so
  // `allowStaleOnFailure` callers can fall back to it. The age bound is
  // enforced here (not just by pruning) so an idle cache can never serve
  // a fallback older than STALE_RETENTION_MS. Expired entries are
  // otherwise dropped below and failures are never written to the cache.
  const previous = ttlMs > 0 ? discoveryCache.get(key) : undefined;
  const stale =
    allowStaleOnFailure &&
    previous &&
    previous.expiresAt <= now &&
    previous.expiresAt + STALE_RETENTION_MS > now
      ? previous
      : undefined;
  pruneExpiredDiscoveryCache(now);
  const cached = ttlMs > 0 ? discoveryCache.get(key) : undefined;
  if (cached && cached.expiresAt > now) return cached.models;

  // The shared promise stays fail-closed: it never returns stale data.
  // Each caller applies its own stale snapshot after the shared discovery
  // settles, so an opt-in caller can never leak stale models into a
  // strict caller (e.g. the ensure-path) sharing the same flight.
  const inFlight = discoveryInFlight.get(key);
  if (inFlight) {
    try {
      return await inFlight;
    } catch (err) {
      if (stale) return stale.models;
      throw err;
    }
  }

  let discovery!: Promise<AdapterModel[]>;
  discovery = (async (): Promise<AdapterModel[]> => {
    try {
      const models = await discoverPiModels({ command, cwd, env });
      if (ttlMs > 0) {
        discoveryCache.set(key, { expiresAt: Date.now() + ttlMs, models });
      }
      return models;
    } finally {
      if (discoveryInFlight.get(key) === discovery) discoveryInFlight.delete(key);
    }
  })();
  discoveryInFlight.set(key, discovery);
  try {
    return await discovery;
  } catch (err) {
    if (stale) return stale.models;
    throw err;
  }
}

export async function ensurePiModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("Pi requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverPiModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error("Pi returned no models. Run `pi --list-models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured Pi model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listPiModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  allowStaleOnFailure?: unknown;
} = {}): Promise<AdapterModel[]> {
  try {
    return await discoverPiModelsCached(input);
  } catch {
    return [];
  }
}

export function resetPiModelsCacheForTests() {
  discoveryCache.clear();
  discoveryInFlight.clear();
}
