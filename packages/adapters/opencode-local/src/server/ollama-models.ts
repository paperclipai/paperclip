/**
 * Dynamic LocalLLM model-config freshness (DEV-653 WS1).
 *
 * Polls the live Ollama server (GET /api/tags), diffs the returned model set
 * against `provider.dev.models` in the OpenCode config, and rewrites only that
 * block when the two drift. Every other config key — `provider.dev.options`,
 * per-model labels, and all non-`dev` providers — is preserved.
 *
 * The config is read as JSONC (OpenCode permits comments and trailing commas)
 * via a string-literal-aware scanner, so in-string values such as
 * `"baseURL": "http://host:11434/v1"` are never corrupted. Every failure mode
 * (unreadable/unparseable config, network error, empty model list, write error)
 * fails safe: the on-disk config is left untouched.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface OllamaConfigDrift {
  /** Models live on the server but absent from the config. */
  added: string[];
  /** Models in the config that the server no longer reports. */
  removed: string[];
  /** Models present in both the config and the server. */
  unchanged: string[];
  /** Total number of models reported by the server. */
  serverCount: number;
}

export type OllamaSyncStatus = "updated" | "unchanged" | "error";

export interface OllamaSyncResult {
  status: OllamaSyncStatus;
  /** True only when the on-disk config was rewritten. */
  changed: boolean;
  configPath: string;
  drift: OllamaConfigDrift | null;
  /** Path of the timestamped backup written before a successful rewrite. */
  backupPath: string | null;
  /** Human-readable reason when `status === "error"`; otherwise null. */
  error: string | null;
}

/** Minimal fetch shape so tests can inject a fake without DOM or real network. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

interface OllamaTag {
  name?: unknown;
  model?: unknown;
}

export interface SyncOllamaModelsOptions {
  /** Override the Ollama base URL. Falls back to `PAPERCLIP_OLLAMA_URL`, then a default. */
  ollamaUrl?: unknown;
  /** Override the config path. Falls back to `PAPERCLIP_OPENCODE_CONFIG`, then XDG. */
  configPath?: unknown;
  /** Fetch timeout in milliseconds. */
  timeoutMs?: number;
  /** Inject a fetch implementation (primarily for tests). */
  fetchImpl?: FetchLike;
}

/* ───────────────────────────── resolution ───────────────────────────── */

export function resolveOllamaUrl(input?: unknown): string {
  if (typeof input === "string" && input.trim().length > 0) return input.trim();
  const env = process.env.PAPERCLIP_OLLAMA_URL;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return DEFAULT_OLLAMA_URL;
}

export function resolveConfigPath(input?: unknown): string {
  if (typeof input === "string" && input.trim().length > 0) return input.trim();
  const env = process.env.PAPERCLIP_OPENCODE_CONFIG;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    typeof xdg === "string" && xdg.trim().length > 0 ? xdg.trim() : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

/* ───────────────────────────── ollama client ────────────────────────── */

export async function fetchOllamaModels(
  ollamaUrl: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<string[]> {
  const doFetch: FetchLike = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${ollamaUrl.replace(/\/+$/, "")}/api/tags`;
  const response = await doFetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/tags returned ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { models?: OllamaTag[] } | null;
  const names = new Set<string>();
  for (const entry of body?.models ?? []) {
    const raw =
      typeof entry?.name === "string"
        ? entry.name
        : typeof entry?.model === "string"
          ? entry.model
          : "";
    const trimmed = raw.trim();
    if (trimmed.length > 0) names.add(trimmed);
  }
  if (names.size === 0) {
    throw new Error("Ollama returned zero models; refusing to rewrite config");
  }
  return [...names].sort();
}

/* ───────────────────────────── JSONC support ────────────────────────── */

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += text[i]; // keep the newline
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
      i++; // skip the closing '/'
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) {
        continue; // drop the trailing comma
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Strip `//` line comments, block comments, and trailing commas from JSONC text
 * without ever touching characters inside string literals.
 */
export function stripJsonc(text: string): string {
  return removeTrailingCommas(stripComments(text));
}

function parseConfig(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(stripJsonc(raw));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode config is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/* ─────────────────────────── drift + mutation ───────────────────────── */

export function computeDrift(existing: readonly string[], server: readonly string[]): OllamaConfigDrift {
  const existingSet = new Set(existing);
  const serverSet = new Set(server);
  return {
    added: server.filter((name) => !existingSet.has(name)),
    removed: existing.filter((name) => !serverSet.has(name)),
    unchanged: server.filter((name) => existingSet.has(name)),
    serverCount: server.length,
  };
}

/**
 * Mutates `config.provider.dev.models` in place to match `serverModels`, preserving
 * any existing per-model entry (hand-tuned labels/options) and leaving every other
 * key untouched. Returns whether anything changed plus the computed drift.
 */
export function applyOllamaModels(
  config: Record<string, unknown>,
  serverModels: readonly string[],
): { changed: boolean; drift: OllamaConfigDrift } {
  const provider = config.provider;
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error('OpenCode config is missing a "provider" object');
  }
  const dev = (provider as Record<string, unknown>).dev;
  if (dev === null || typeof dev !== "object" || Array.isArray(dev)) {
    throw new Error('OpenCode config is missing a "provider.dev" object');
  }
  const devObject = dev as Record<string, unknown>;
  const existingModels =
    devObject.models !== null && typeof devObject.models === "object" && !Array.isArray(devObject.models)
      ? (devObject.models as Record<string, unknown>)
      : {};

  const existingNames = Object.keys(existingModels).sort();
  const serverSorted = [...serverModels].sort();
  const drift = computeDrift(existingNames, serverSorted);

  if (drift.added.length === 0 && drift.removed.length === 0) {
    return { changed: false, drift };
  }

  const nextModels: Record<string, unknown> = {};
  for (const name of serverSorted) {
    const previous = existingModels[name];
    nextModels[name] =
      previous !== null && typeof previous === "object" && !Array.isArray(previous) ? previous : { name };
  }
  devObject.models = nextModels;
  return { changed: true, drift };
}

/* ───────────────────────────── atomic write ─────────────────────────── */

/**
 * Writes `content` to `filePath` atomically (temp file + fsync + rename) after
 * backing up the current file to a timestamped `.bak`. Returns the backup path, or
 * null when no prior file existed.
 */
export function atomicWriteWithBackup(filePath: string, content: string): string | null {
  const directory = path.dirname(filePath);
  let backupPath: string | null = null;
  try {
    const current = fs.readFileSync(filePath, "utf8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backupPath = `${filePath}.${stamp}.bak`;
    fs.writeFileSync(backupPath, current, "utf8");
  } catch {
    backupPath = null; // best-effort backup; do not block on a missing source file
  }

  const tempPath = path.join(directory, `.opencode-ollama-sync-${randomUUID()}.tmp`);
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
  return backupPath;
}

/* ─────────────────────────────── entry point ────────────────────────── */

export async function syncOllamaModels(options: SyncOllamaModelsOptions = {}): Promise<OllamaSyncResult> {
  const configPath = resolveConfigPath(options.configPath);
  const ollamaUrl = resolveOllamaUrl(options.ollamaUrl);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return errorResult(configPath, `cannot read config: ${messageOf(error)}`);
  }

  let config: Record<string, unknown>;
  try {
    config = parseConfig(raw);
  } catch (error) {
    return errorResult(configPath, `cannot parse config: ${messageOf(error)}`);
  }

  let serverModels: string[];
  try {
    serverModels = await fetchOllamaModels(ollamaUrl, {
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    return errorResult(configPath, `Ollama fetch failed (${messageOf(error)}); config left untouched`);
  }

  let applied: { changed: boolean; drift: OllamaConfigDrift };
  try {
    applied = applyOllamaModels(config, serverModels);
  } catch (error) {
    return errorResult(configPath, `cannot update config: ${messageOf(error)}`);
  }

  if (!applied.changed) {
    return {
      status: "unchanged",
      changed: false,
      configPath,
      drift: applied.drift,
      backupPath: null,
      error: null,
    };
  }

  let backupPath: string | null;
  try {
    backupPath = atomicWriteWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    return errorResult(configPath, `atomic write failed: ${messageOf(error)}`);
  }

  return {
    status: "updated",
    changed: true,
    configPath,
    drift: applied.drift,
    backupPath,
    error: null,
  };
}

function errorResult(configPath: string, error: string): OllamaSyncResult {
  return { status: "error", changed: false, configPath, drift: null, backupPath: null, error };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
