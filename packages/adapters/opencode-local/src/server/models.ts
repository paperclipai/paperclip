import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";

const MODELS_CACHE_TTL_MS = 300_000;
const MODELS_FAILURE_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS_DEFAULT = 30_000;

function resolveModelsTimeoutMs(): number {
  const envValue =
    typeof process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS === "string" &&
    process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS.trim().length > 0
      ? Number(process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS.trim())
      : NaN;
  return Number.isFinite(envValue) && envValue > 0 ? envValue : MODELS_DISCOVERY_TIMEOUT_MS_DEFAULT;
}

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

type DiscoveryCacheEntry =
  | { kind: "success"; expiresAt: number; models: AdapterModel[] }
  | { kind: "failure"; expiresAt: number };

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
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

const MODELS_DISCOVERY_RETRY_DELAYS_MS = [2_000];

async function discoverOpenCodeModelsOnce(params: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<AdapterModel[]> {
  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({
      ...process.env,
      ...params.env,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    }),
  );

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    params.command,
    ["models"],
    {
      cwd: params.cwd,
      env: runtimeEnv,
      timeoutSec: params.timeoutMs / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${params.timeoutMs / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseOpenCodeModelsOutput(result.stdout));
}

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
  }

  const runtimeEnv = { ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}) };
  const timeoutMs = resolveModelsTimeoutMs();
  const baseParams = { command, cwd, env: runtimeEnv, timeoutMs };

  let lastError: unknown;
  for (let attempt = 0; attempt <= MODELS_DISCOVERY_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = MODELS_DISCOVERY_RETRY_DELAYS_MS[attempt - 1];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await discoverOpenCodeModelsOnce(baseParams);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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
  if (cached && cached.expiresAt > now) {
    if (cached.kind === "failure") throw new Error("OpenCode model discovery failed (cached failure).");
    return cached.models;
  }

  try {
    const models = await discoverOpenCodeModels({ command, cwd, env });
    discoveryCache.set(key, { kind: "success", expiresAt: now + MODELS_CACHE_TTL_MS, models });
    return models;
  } catch (err) {
    discoveryCache.set(key, { kind: "failure", expiresAt: now + MODELS_FAILURE_CACHE_TTL_MS });
    throw err;
  }
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireOpenCodeModelId(input.model);

  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

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

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
