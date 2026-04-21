import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_AUGGIE_LOCAL_MODEL } from "../index.js";
import { firstNonEmptyLine } from "./utils.js";

const MODELS_CACHE_TTL_MS = 300_000;
const MODELS_DISCOVERY_TIMEOUT_SEC = 20;

function resolveAuggieCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_AUGGIE_COMMAND === "string" &&
    process.env.PAPERCLIP_AUGGIE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_AUGGIE_COMMAND.trim()
      : "auggie";
  return asString(input, envOverride);
}

interface AuggieModelEntry {
  displayName?: unknown;
  shortName?: unknown;
  description?: unknown;
  isLegacyModel?: unknown;
  isDefault?: unknown;
  modelGroupPriority?: unknown;
  costTier?: unknown;
}

interface AuggieModelsResponse {
  registryAvailable?: unknown;
  defaultModelId?: unknown;
  models?: unknown;
}

function normalizeEntries(payload: AuggieModelsResponse): Array<{
  id: string;
  displayName: string;
  isLegacy: boolean;
  priority: number;
  costTier: number;
}> {
  const raw = Array.isArray(payload.models)
    ? (payload.models as AuggieModelEntry[])
    : [];
  const out: Array<{
    id: string;
    displayName: string;
    isLegacy: boolean;
    priority: number;
    costTier: number;
  }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id =
      typeof entry.shortName === "string" ? entry.shortName.trim() : "";
    if (!id) continue;
    const displayName =
      typeof entry.displayName === "string" &&
      entry.displayName.trim().length > 0
        ? entry.displayName.trim()
        : id;
    const isLegacy = entry.isLegacyModel === true;
    const priority =
      typeof entry.modelGroupPriority === "number"
        ? entry.modelGroupPriority
        : 999;
    const costTier = typeof entry.costTier === "number" ? entry.costTier : 0;
    out.push({ id, displayName, isLegacy, priority, costTier });
  }
  return out;
}

export function parseAuggieModelsJson(stdout: string): AdapterModel[] {
  let payload: AuggieModelsResponse;
  try {
    payload = JSON.parse(stdout) as AuggieModelsResponse;
  } catch {
    return [];
  }
  const entries = normalizeEntries(payload);
  if (entries.length === 0) return [];

  // Non-legacy first (by priority asc, cost tier asc, id), then legacy (alpha).
  const current = entries
    .filter((e) => !e.isLegacy)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.costTier !== b.costTier) return a.costTier - b.costTier;
      return a.id.localeCompare(b.id, "en", {
        numeric: true,
        sensitivity: "base",
      });
    });
  const legacy = entries
    .filter((e) => e.isLegacy)
    .sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
    );

  const mapped: AdapterModel[] = [
    { id: DEFAULT_AUGGIE_LOCAL_MODEL, label: "Auto (account default)" },
    ...current.map((e) => ({ id: e.id, label: e.displayName })),
    ...legacy.map((e) => ({ id: e.id, label: `${e.displayName} (legacy)` })),
  ];

  // Dedupe by id while keeping first occurrence (preserves "auto" sentinel).
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const m of mapped) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped;
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const discoveryCache = new Map<
  string,
  { expiresAt: number; models: AdapterModel[] }
>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM_SESSION_ID",
]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function discoveryCacheKey(
  command: string,
  cwd: string,
  env: Record<string, string>,
) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${key}=${createHash("sha256").update(value).digest("hex")}`,
    )
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

export async function discoverAuggieModels(
  input: { command?: unknown; cwd?: unknown; env?: unknown } = {},
): Promise<AdapterModel[]> {
  const command = resolveAuggieCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `auggie-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models", "list", "--json"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_SEC,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(
      `\`auggie models list --json\` timed out after ${MODELS_DISCOVERY_TIMEOUT_SEC}s.`,
    );
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail =
      firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(
      detail
        ? `\`auggie models list --json\` failed: ${detail}`
        : "`auggie models list --json` failed.",
    );
  }

  const parsed = parseAuggieModelsJson(result.stdout);
  if (parsed.length === 0) {
    throw new Error("`auggie models list --json` returned no models.");
  }
  return parsed;
}

export async function discoverAuggieModelsCached(
  input: { command?: unknown; cwd?: unknown; env?: unknown } = {},
): Promise<AdapterModel[]> {
  const command = resolveAuggieCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  for (const [k, v] of discoveryCache.entries()) {
    if (v.expiresAt <= now) discoveryCache.delete(k);
  }
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;
  const models = await discoverAuggieModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function listAuggieModels(): Promise<AdapterModel[]> {
  try {
    return await discoverAuggieModelsCached();
  } catch {
    // Return [] to let the server's listAdapterModels fall back to the
    // static `models` export (same pattern as pi-local / opencode-local).
    return [];
  }
}

export function resetAuggieModelsCacheForTests() {
  discoveryCache.clear();
}
