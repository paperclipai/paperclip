import { createHash } from "node:crypto";
import type { AdapterModel } from "@penclipai/adapter-utils";
import { asString, ensurePathInEnv, runChildProcess } from "@penclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function resolveCodeBuddyCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_CODEBUDDY_COMMAND === "string"
      && process.env.PAPERCLIP_CODEBUDDY_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_CODEBUDDY_COMMAND.trim()
      : "codebuddy";
  return asString(input, envOverride);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
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

function parseCodeBuddyModelsFromHelp(output: string): AdapterModel[] {
  const match = output.match(/--model\s+<model>[\s\S]*?Currently supported:\s*\(([^)]+)\)/i);
  if (!match?.[1]) return [];
  return sortModels(
    dedupeModels(
      match[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((id) => ({ id, label: id })),
    ),
  );
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

export async function discoverCodeBuddyModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCodeBuddyCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const result = await runChildProcess(
    `codebuddy-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--help"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`codebuddy --help` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`codebuddy --help\` failed: ${detail}` : "`codebuddy --help` failed.");
  }

  return parseCodeBuddyModelsFromHelp(result.stdout);
}

export async function discoverCodeBuddyModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCodeBuddyCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverCodeBuddyModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureCodeBuddyModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[] | null> {
  const model = asString(input.model, "").trim();
  if (!model) return null;

  let models: AdapterModel[];
  try {
    models = await discoverCodeBuddyModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch {
    return null;
  }

  if (models.length === 0) return null;
  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured CodeBuddy model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listCodeBuddyModels(): Promise<AdapterModel[]> {
  try {
    return await discoverCodeBuddyModelsCached();
  } catch {
    return [];
  }
}

export function resetCodeBuddyModelsCacheForTests() {
  discoveryCache.clear();
}
