import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const OPENROUTER_MODELS_TIMEOUT_MS = 5_000;
const OPENROUTER_MODELS_CACHE_TTL_MS = 60_000;
const OPENROUTER_ALLOWLIST_DEFAULT: readonly string[] = [
  "openai/",
  "anthropic/",
  "qwen/",
  "deepseek/",
  "google/",
];

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

let openRouterModelsCache: {
  keyFingerprint: string;
  expiresAt: number;
  models: AdapterModel[];
} | null = null;

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

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

function resolveOpenRouterApiKey(): string | null {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function parseOpenRouterAllowlist(): string[] {
  const raw = process.env.PAPERCLIP_OPENROUTER_MODEL_ALLOWLIST?.trim();
  if (!raw) return [...OPENROUTER_ALLOWLIST_DEFAULT];

  if (raw === "*") return ["*"];

  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry === "*") return "*";
      return entry.endsWith("/") ? entry : `${entry}/`;
    });

  if (entries.length === 0) return [...OPENROUTER_ALLOWLIST_DEFAULT];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
  }
  return deduped;
}

function normalizeOpenRouterModelId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}

function hasOpenRouterModelAllowlistMatch(modelId: string, allowlist: string[]): boolean {
  const lowerId = modelId.toLowerCase();
  if (allowlist.includes("*")) return true;
  return allowlist.some((entry) => {
    const normalized = entry.endsWith("/") ? entry : `${entry}/`;
    return lowerId.startsWith(normalized);
  });
}

function filterAndPrefixOpenRouterModels(input: AdapterModel[]): AdapterModel[] {
  const allowlist = parseOpenRouterAllowlist();
  const filtered: AdapterModel[] = [];

  for (const model of input) {
    const rawId = normalizeOpenRouterModelId(model.id);
    if (!rawId) continue;
    if (!hasOpenRouterModelAllowlistMatch(rawId, allowlist)) continue;
    filtered.push({ id: `openrouter/${rawId}`, label: model.label || rawId });
  }

  return dedupeModels(filtered);
}

function pruneExpiredOpenRouterModelsCache(now: number) {
  if (!openRouterModelsCache) return;
  if (openRouterModelsCache.expiresAt > now) return;
  openRouterModelsCache = null;
}

async function fetchOpenRouterModels(apiKey: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const parsed: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const normalized = normalizeOpenRouterModelId(record.id);
      if (!normalized) continue;
      const label =
        typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : normalized;
      parsed.push({ id: normalized, label });
    }
    return dedupeModels(parsed);
  } catch (error) {
    console.warn("[paperclip] OpenRouter model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverOpenRouterModelsCached(): Promise<AdapterModel[]> {
  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) return [];

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  pruneExpiredOpenRouterModelsCache(now);
  if (openRouterModelsCache && openRouterModelsCache.keyFingerprint === keyFingerprint) {
    return openRouterModelsCache.models;
  }

  const fetched = await fetchOpenRouterModels(apiKey);
  if (fetched.length > 0) {
    openRouterModelsCache = {
      keyFingerprint,
      expiresAt: now + OPENROUTER_MODELS_CACHE_TTL_MS,
      models: fetched,
    };
    return fetched;
  }

  if (
    openRouterModelsCache &&
    openRouterModelsCache.keyFingerprint === keyFingerprint &&
    openRouterModelsCache.models.length > 0
  ) {
    return openRouterModelsCache.models;
  }

  return [];
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
  const [discovered, openRouterRaw] = await Promise.all([
    discoverOpenCodeModelsCached().catch(() => []),
    discoverOpenRouterModelsCached().catch(() => []),
  ]);
  const openRouterModels = filterAndPrefixOpenRouterModels(openRouterRaw);
  // OpenRouter entries first so their curated catalog labels win over the raw
  // `openrouter/<id>` labels that `opencode models` echoes for the same ids
  // (dedupeModels keeps the first occurrence of each id).
  return sortModels(dedupeModels([...openRouterModels, ...discovered]));
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
  openRouterModelsCache = null;
}
