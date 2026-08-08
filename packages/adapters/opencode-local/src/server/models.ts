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
const MODELS_DISCOVERY_TIMEOUT_DEFAULT_MS = 20_000;
const MODELS_DISCOVERY_GRACE_FRACTION = 0.2;
const MODELS_DISCOVERY_GRACE_MIN_SEC = 3;

// `opencode models` discovery timeout is env-configurable (XIP-4907 / XIP-4690):
// under host saturation enumeration that idles in ~0.06s can take many seconds,
// tripping the hardcoded 20s wall for every fanned-out researcher at once. The
// real fix is the host-global concurrency gate + single-flight below; the env
// knob is an operator escape hatch, not a substitute.
function getModelsDiscoveryTimeoutMs(): number {
  const raw = Number(process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return MODELS_DISCOVERY_TIMEOUT_DEFAULT_MS;
  return Math.floor(raw);
}

// Grace scales with the timeout so a larger timeout also gets a larger window for
// the child to exit on SIGTERM before SIGKILL.
function getModelsDiscoveryGraceSec(timeoutMs: number): number {
  return Math.max(
    MODELS_DISCOVERY_GRACE_MIN_SEC,
    Math.ceil((timeoutMs / 1000) * MODELS_DISCOVERY_GRACE_FRACTION),
  );
}

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

// The model list is per-binary / per-provider-auth, NOT per-cwd, so `cwd` is
// deliberately excluded from the key (XIP-4907 / XIP-4690): each researcher runs
// from a distinct cwd, and keying on cwd made every one of them miss the cache
// and re-enumerate. Keyed on the resolved command + non-volatile env only.
function discoveryCacheKey(command: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${envKey}`;
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

  const timeoutMs = getModelsDiscoveryTimeoutMs();
  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: timeoutMs / 1000,
      graceSec: getModelsDiscoveryGraceSec(timeoutMs),
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${timeoutMs / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseOpenCodeModelsOutput(result.stdout));
}

// In-flight discovery promises keyed by discoveryCacheKey. Single-flight: while
// one `opencode models` spawn is in progress, concurrent callers with the same
// key share its promise instead of each spawning their own.
const inFlightDiscovery = new Map<string, Promise<AdapterModel[]>>();

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  // Single-flight (XIP-4907 / XIP-4690): when ~6 researcher agents fan out at
  // once they all miss the not-yet-populated cache and would each spawn their own
  // `opencode models` — the enumeration herd that saturates the host. Collapse
  // them onto ONE spawn per key; the winner populates the cache for the rest.
  const existing = inFlightDiscovery.get(key);
  if (existing) return existing;

  // Error handling is intentionally fail-open with NO negative caching (XIP-4911,
  // Greptile Issue 2): on a spawn failure the rejection is shared by all callers
  // that joined this single flight, and we cache nothing — so the *next* fan-out
  // wave re-spawns rather than serving a stale error. This is deliberate: a failed
  // probe is usually transient (auth not yet warm, command briefly missing) and a
  // negative cache would wrongly suppress a now-recoverable enumeration. The
  // herd risk this PR targets is already bounded — single-flight collapses an
  // entire concurrent burst onto ONE spawn even when it fails, and successive
  // fan-out waves are spaced by the heartbeat scheduler, so failures cannot
  // tight-loop re-spawn. If failure storms are ever observed in prod, add a short
  // negative-cache TTL on `key` here.
  const discovery = (async () => {
    const models = await discoverOpenCodeModels({ command, cwd, env });
    discoveryCache.set(key, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models });
    return models;
  })().finally(() => {
    inFlightDiscovery.delete(key);
  });
  inFlightDiscovery.set(key, discovery);
  return discovery;
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
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
  inFlightDiscovery.clear();
}
