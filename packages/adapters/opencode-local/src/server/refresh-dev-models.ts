import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Dynamic LocalLLM model-config freshness (durable TypeScript port).
 *
 * Polls the live Ollama server and rewrites ONLY `provider.dev.models` in the
 * SOURCE opencode config (`~/.config/opencode/opencode.json`) so the
 * hand-maintained model list can never drift from what the server actually
 * serves.
 *
 * Design guarantees (fail-safe by construction — mirrors the proven
 * Python reference implementation):
 *   - Preserves `provider.dev.options` (baseURL/timeout/apiKey/...) verbatim.
 *   - Preserves every non-`dev` provider and all other top-level keys/order.
 *   - JSONC-tolerant read (strips `//` and `/* *\/` comments and trailing
 *     commas) so a hand-edited source with comments still parses. The stripper
 *     is string-literal aware so it never corrupts URLs like `http://` inside
 *     values.
 *   - Atomic write (temp file + rename) and a timestamped `.bak` before write.
 *   - On ANY fetch/parse/empty-result error it leaves the existing good config
 *     untouched and throws. It NEVER clobbers a good config with junk.
 *
 * The JSONC parsing is implemented inline (dependency-free) to match the
 * sibling `runtime-config.ts` module in this package, which also avoids adding
 * a JSON5/jsonc-parser runtime dependency. The behaviour is exercised
 * exhaustively in `refresh-dev-models.test.ts`.
 */

export const DEFAULT_PROVIDER_KEY = "dev";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Error raised for every fail-safe condition. The CLI maps it to exit code 1. */
export class RefreshDevModelsError extends Error {
  override name = "RefreshDevModelsError";
}

export interface DevModelLabel {
  name: string;
}

export type DevModelsBlock = Record<string, DevModelLabel>;

export interface ModelDrift {
  added: string[];
  removed: string[];
  /** true when the serialized models block differs (keys OR labels). */
  changed: boolean;
}

export interface RefreshDevModelsResult {
  changed: boolean;
  modelCount: number;
  added: string[];
  removed: string[];
  configPath: string;
  ollamaUrl: string;
  dryRun: boolean;
  /** Set only when a write happened (not on dry-run / no-op). */
  backupPath?: string;
  /** The serialized config that was (or would be) written. */
  payload: string;
}

export interface RefreshDevModelsOptions {
  /** Source opencode config path. Defaults to `~/.config/opencode/opencode.json`. */
  configPath?: string;
  /** Explicit Ollama base URL. Overrides derivation from config / env. */
  ollamaUrl?: string;
  /** Provider key to keep fresh. Defaults to `dev`. */
  providerKey?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  /** Injectable for tests / non-global runtimes. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic backup timestamps in tests. */
  now?: () => Date;
  /** Optional structured logger; defaults to stderr. */
  logger?: (message: string) => void;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove `//` and `/* *\/` comments and trailing commas so `JSON.parse`
 * accepts a JSONC source. String-literal aware so a `http://` inside a value
 * is never mistaken for a line comment.
 */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  let inStr = false;
  let quote = "";
  while (i < n) {
    const c = text[i]!;
    if (inStr) {
      out.push(c);
      if (c === "\\" && i + 1 < n) {
        out.push(text[i + 1]!);
        i += 2;
        continue;
      }
      if (c === quote) inStr = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out.push(c);
      i += 1;
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  // Drop trailing commas before } or ]
  return out.join("").replace(/,(\s*[}\]])/g, "$1");
}

/** Parse JSON, falling back to a JSONC-tolerant strip on the first failure. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonc(text));
  }
}

/**
 * Extract sorted, de-duplicated, non-empty model names from an Ollama
 * `/api/tags` response body. Throws (fail-safe) when the server reports zero
 * usable models so we never clobber a good config with an empty list.
 */
export function extractOllamaModelNames(tags: unknown): string[] {
  const models = isPlainObject(tags) && Array.isArray(tags.models) ? tags.models : null;
  if (!models) {
    throw new RefreshDevModelsError(
      "Ollama /api/tags response missing a `models` array; refusing to touch config.",
    );
  }
  const names = new Set<string>();
  for (const entry of models) {
    if (isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim().length > 0) {
      names.add(entry.name.trim());
    }
  }
  if (names.size === 0) {
    throw new RefreshDevModelsError("Ollama returned zero models; refusing to clobber config.");
  }
  return [...names].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

/**
 * Map each live model name to `{ name: <label> }`, keeping any human label the
 * source already had for a model that still exists; otherwise default the
 * label to the tag itself. Output key order follows the (sorted) `names`.
 */
export function buildDevModelsBlock(names: string[], existing: unknown): DevModelsBlock {
  const prev = isPlainObject(existing) ? existing : {};
  const block: DevModelsBlock = {};
  for (const name of names) {
    const prevEntry = prev[name];
    const label =
      isPlainObject(prevEntry) && typeof prevEntry.name === "string" && prevEntry.name.trim().length > 0
        ? prevEntry.name
        : name;
    block[name] = { name: label };
  }
  return block;
}

/** Compute add/remove drift plus a `changed` flag (keys OR labels differ). */
export function computeModelDrift(existing: unknown, nextBlock: DevModelsBlock): ModelDrift {
  const prev = isPlainObject(existing) ? existing : {};
  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(nextBlock));
  const added = [...nextKeys].filter((k) => !prevKeys.has(k)).sort();
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k)).sort();
  const changed = JSON.stringify(normalizeBlock(prev)) !== JSON.stringify(nextBlock);
  return { added, removed, changed };
}

// Normalize an arbitrary existing models value into a comparable block shape so
// label-only changes are detected without throwing on malformed entries.
function normalizeBlock(existing: Record<string, unknown>): DevModelsBlock {
  const out: DevModelsBlock = {};
  for (const key of Object.keys(existing)) {
    const entry = existing[key];
    out[key] = {
      name: isPlainObject(entry) && typeof entry.name === "string" ? entry.name : key,
    };
  }
  return out;
}

/**
 * Pure transform: return a new config object with ONLY `provider.<key>.models`
 * replaced by the fresh block. Preserves `options`, every other provider, and
 * all other top-level keys (and their order). Throws (fail-safe) when
 * `provider.<key>` is missing/invalid.
 */
export function applyDevModelRefresh(
  config: unknown,
  names: string[],
  providerKey: string = DEFAULT_PROVIDER_KEY,
): { nextConfig: Record<string, unknown>; drift: ModelDrift; nextBlock: DevModelsBlock } {
  if (!isPlainObject(config)) {
    throw new RefreshDevModelsError("Source config is not a JSON object; not touching config.");
  }
  const provider = config.provider;
  if (!isPlainObject(provider) || !isPlainObject(provider[providerKey])) {
    throw new RefreshDevModelsError(
      `provider.${providerKey} missing/invalid; not touching config.`,
    );
  }
  const dev = provider[providerKey] as Record<string, unknown>;
  const existing = dev.models;
  const nextBlock = buildDevModelsBlock(names, existing);
  const drift = computeModelDrift(existing, nextBlock);
  const nextConfig: Record<string, unknown> = {
    ...config,
    provider: {
      ...provider,
      [providerKey]: { ...dev, models: nextBlock },
    },
  };
  return { nextConfig, drift, nextBlock };
}

/** Derive the Ollama base URL: explicit option > env > config baseURL > default. */
export function deriveOllamaBaseUrl(
  config: unknown,
  options: { explicit?: string; env?: Record<string, string | undefined>; providerKey?: string } = {},
): string {
  const explicit = options.explicit?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  const env = options.env ?? process.env;
  const fromEnv = env.OLLAMA_URL?.trim();
  if (fromEnv) return stripTrailingSlash(fromEnv);
  const providerKey = options.providerKey ?? DEFAULT_PROVIDER_KEY;
  if (isPlainObject(config) && isPlainObject(config.provider)) {
    const dev = (config.provider as Record<string, unknown>)[providerKey];
    if (isPlainObject(dev) && isPlainObject(dev.options)) {
      const baseURL = (dev.options as Record<string, unknown>).baseURL;
      if (typeof baseURL === "string" && baseURL.trim().length > 0) {
        // The OpenAI-compatible provider points at `.../v1`; the Ollama tags
        // API lives at the host root, so strip a trailing `/v1`.
        return stripTrailingSlash(baseURL.trim().replace(/\/v1\/?$/, ""));
      }
    }
  }
  return DEFAULT_OLLAMA_URL;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Fetch + extract live model names from Ollama `/api/tags` (fail-safe). */
export async function fetchOllamaModelNames(
  baseUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RefreshDevModelsError("No fetch implementation available to poll Ollama.");
  }
  const url = `${stripTrailingSlash(baseUrl)}/api/tags`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new RefreshDevModelsError(`Ollama /api/tags returned HTTP ${res.status}.`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof RefreshDevModelsError) throw err;
    throw new RefreshDevModelsError(
      `Ollama fetch failed (${err instanceof Error ? err.message : String(err)}); leaving config intact.`,
    );
  } finally {
    clearTimeout(timeout);
  }
  return extractOllamaModelNames(body);
}

/** Read + JSONC-parse the source config (fail-safe on unreadable/unparseable). */
export async function readSourceConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    throw new RefreshDevModelsError(
      `cannot read source config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    throw new RefreshDevModelsError(
      `cannot parse source config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new RefreshDevModelsError(`source config ${configPath} is not a JSON object.`);
  }
  return parsed;
}

/** Atomic write: temp file in the same dir, fsync, then rename over the target. */
export async function writeFileAtomic(filePath: string, payload: string): Promise<void> {
  const dir = path.dirname(filePath) || ".";
  const tmp = path.join(dir, `.opencode-cfg-${randomBytes(6).toString("hex")}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export function defaultConfigPath(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Orchestrator: poll Ollama and rewrite `provider.dev.models` in the source
 * config, fail-safe throughout. Returns a structured result describing the
 * drift and any backup written. Never writes when nothing changed.
 */
export async function refreshDevModels(
  options: RefreshDevModelsOptions = {},
): Promise<RefreshDevModelsResult> {
  const providerKey = options.providerKey ?? DEFAULT_PROVIDER_KEY;
  const configPath = options.configPath ?? defaultConfigPath();
  const log = options.logger ?? ((m: string) => process.stderr.write(`[refresh-dev-models] ${m}\n`));

  // 1) Load existing config (fail-safe: bail before any write).
  const config = await readSourceConfig(configPath);

  // 2) Resolve the Ollama endpoint (explicit > env > config baseURL > default).
  const ollamaUrl = deriveOllamaBaseUrl(config, { explicit: options.ollamaUrl, providerKey });

  // 3) Fetch live models (fail-safe: bail on any network/parse/empty error).
  const names = await fetchOllamaModelNames(ollamaUrl, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  // 4) Compute the fresh block + drift (throws if provider.<key> invalid).
  const { nextConfig, drift } = applyDevModelRefresh(config, names, providerKey);
  const payload = `${JSON.stringify(nextConfig, null, 2)}\n`;

  const baseResult: RefreshDevModelsResult = {
    changed: drift.changed,
    modelCount: names.length,
    added: drift.added,
    removed: drift.removed,
    configPath,
    ollamaUrl,
    dryRun: Boolean(options.dryRun),
    payload,
  };

  if (!drift.changed) {
    log(`already fresh: ${names.length} models, no change`);
    return baseResult;
  }

  log(
    `drift: +${drift.added.length} -${drift.removed.length} (server now has ${names.length})`,
  );
  if (drift.added.length > 0) log(`  added: ${drift.added.join(", ")}`);
  if (drift.removed.length > 0) log(`  removed (phantom): ${drift.removed.join(", ")}`);

  if (options.dryRun) {
    log("dry-run: not writing");
    return baseResult;
  }

  // 5) Timestamped backup of the current bytes, then atomic replace.
  const ts = timestamp((options.now ?? (() => new Date()))());
  const backupPath = `${configPath}.${ts}.bak`;
  let priorBytes: string;
  try {
    priorBytes = await fs.readFile(configPath, "utf8");
  } catch (err) {
    throw new RefreshDevModelsError(
      `could not re-read config for backup (${err instanceof Error ? err.message : String(err)}); aborting before write.`,
    );
  }
  try {
    await writeFileAtomic(backupPath, priorBytes);
  } catch (err) {
    throw new RefreshDevModelsError(
      `could not write backup ${backupPath} (${err instanceof Error ? err.message : String(err)}); aborting before write.`,
    );
  }
  try {
    await writeFileAtomic(configPath, payload);
  } catch (err) {
    throw new RefreshDevModelsError(
      `atomic write failed (${err instanceof Error ? err.message : String(err)}); backup preserved at ${backupPath}.`,
    );
  }

  log(`updated ${configPath} (backup: ${backupPath})`);
  return { ...baseResult, backupPath };
}
