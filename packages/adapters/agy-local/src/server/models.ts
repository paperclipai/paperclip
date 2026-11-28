import { createHash } from "node:crypto";
import { models as fallbackModels } from "../index.js";
import {
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";

// Model discovery spawns the host CLI, so repeated catalog reads share one
// result for a short window instead of spawning a process per request (the
// same 60-second TTL the opencode-local and pi-local adapters use). Any
// company member can hit the catalog route, so an uncached read is a cheap
// way to exhaust host process capacity.
const MODELS_CACHE_TTL_MS = 60_000;

type AgyModel = { id: string; label: string };

const discoveryCache = new Map<string, { expiresAt: number; models: AgyModel[] }>();
const discoveryInFlight = new Map<string, Promise<AgyModel[]>>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM_SESSION_ID",
  "HOME",
]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${createHash("sha256").update(value).digest("hex")}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

// The discovery probe runs with a sanitized copy of the server environment:
// no Paperclip control-plane variables and no agent identity variables leak
// into the spawned CLI (mirrors pi-local).
function resolveDiscoveryEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizeInheritedPaperclipEnv(process.env))) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function parseAgyModelsOutput(output: string): { id: string; label: string }[] {
  const models: { id: string; label: string }[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    // Strip ANSI codes, spinners, and progress messages
    const cleanLine = rawLine
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")
      .replace(/Fetching available models\.\.\./g, "")
      .trim();

    if (!cleanLine || cleanLine.startsWith("Available")) {
      continue;
    }

    const match = cleanLine.match(/^([a-zA-Z0-9_.-]+)\s{2,}(.+)$/) || cleanLine.match(/^([a-zA-Z0-9_.-]+)\s+(.+)$/);
    if (match) {
      const id = match[1]!.trim();
      const label = match[2]!.trim();
      if (id && label && !models.some((m) => m.id === id)) {
        models.push({ id, label });
      }
    }
  }

  return models;
}

export async function discoverAgyModels(command = "agy"): Promise<{ id: string; label: string }[]> {
  try {
    const proc = await runChildProcess(
      `agy-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["models"],
      {
        cwd: process.cwd(),
        env: resolveDiscoveryEnv(),
        timeoutSec: 15,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (proc.exitCode === 0 && proc.stdout.trim().length > 0) {
      const discovered = parseAgyModelsOutput(proc.stdout);
      if (discovered.length > 0) {
        return discovered;
      }
    }
  } catch {
    // Probing unavailable; fallback to static model list
  }

  return fallbackModels;
}

// At most one discovery runs per cache key. A refresh that arrives while a
// lookup is in flight joins it instead of starting a second spawn, so the
// older lookup can never finish afterward and overwrite the refreshed list
// (a timed-out older lookup would otherwise replace a successful refresh
// with fallback models for the whole TTL).
function getOrStartDiscovery(key: string, command: string): Promise<{ id: string; label: string }[]> {
  // Concurrent cache misses share one spawn instead of each starting its own.
  const inFlight = discoveryInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = discoverAgyModels(command)
    .then((models) => {
      discoveryCache.set(key, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models });
      return models;
    })
    .finally(() => {
      if (discoveryInFlight.get(key) === promise) discoveryInFlight.delete(key);
    });
  discoveryInFlight.set(key, promise);
  return promise;
}

export async function listAgyModels(command = "agy"): Promise<{ id: string; label: string }[]> {
  const cwd = process.cwd();
  const key = discoveryCacheKey(command, cwd, resolveDiscoveryEnv());
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  return getOrStartDiscovery(key, command);
}

export async function refreshAgyModels(command = "agy"): Promise<{ id: string; label: string }[]> {
  const cwd = process.cwd();
  const key = discoveryCacheKey(command, cwd, resolveDiscoveryEnv());
  // Skip the cache read so an explicit refresh always re-discovers, but join
  // a lookup already in flight rather than spawning a second one.
  return getOrStartDiscovery(key, command);
}

export function resetAgyModelsCacheForTests() {
  discoveryCache.clear();
  discoveryInFlight.clear();
}

export function inferModelProvider(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (
    normalized.startsWith("gpt") ||
    normalized.startsWith("openai") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3")
  ) {
    return "openai";
  }
  return "google";
}
