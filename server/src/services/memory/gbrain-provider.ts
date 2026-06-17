import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemoryContextBundle,
  MemoryPage,
  MemoryProvider,
  MemoryProviderCaptureRequest,
  MemoryProviderErrorCode,
  MemoryProviderQueryRequest,
  MemoryProviderResult,
  MemorySnippet,
} from "./types.js";
import { MEMORY_BINDING_CONFIG_DEFAULTS } from "./types.js";

/**
 * gbrain CLI provider: wraps `gbrain call <tool> '<json>'` (JSON on stdout).
 *
 * gbrain is a personal, instance-global brain, so this provider enforces the
 * Paperclip boundary by only returning or writing slugs under the immutable
 * `paperclip/companies/<companyId>/` namespace.
 */

const AVAILABILITY_CACHE_MS = 60_000;
const EXEC_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const ERROR_MESSAGE_MAX_CHARS = 500;

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<ExecFileResult>;

export type AccessFn = (filePath: string) => Promise<void>;

export interface GbrainMemoryProviderOptions {
  binPath?: string | null;
  env?: NodeJS.ProcessEnv;
  execFileFn?: ExecFileFn;
  accessFn?: AccessFn;
  availabilityCacheMs?: number;
}

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise<ExecFileResult>((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const defaultAccess: AccessFn = (filePath) => fs.access(filePath, fsConstants.X_OK);

/**
 * Binary resolution order: explicit config binPath → PAPERCLIP_GBRAIN_BIN env
 * → ~/.local/bin/gbrain → first executable `gbrain` on PATH. The server runs
 * via LaunchAgent whose PATH may not include ~/.local/bin, hence the absolute
 * candidates first.
 */
export async function resolveGbrainBinPath(options: {
  binPath?: string | null;
  env?: NodeJS.ProcessEnv;
  accessFn?: AccessFn;
} = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const access = options.accessFn ?? defaultAccess;
  const candidates: string[] = [];
  if (typeof options.binPath === "string" && options.binPath.length > 0) {
    candidates.push(options.binPath);
  }
  const envBin = env.PAPERCLIP_GBRAIN_BIN;
  if (typeof envBin === "string" && envBin.length > 0) {
    candidates.push(envBin);
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", "gbrain"));
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (dir.length > 0) candidates.push(path.join(dir, "gbrain"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not executable here; try the next candidate
    }
  }
  return null;
}

/**
 * The CLI may print warnings before the JSON payload; find the first JSON
 * bracket and parse from there when a straight parse fails.
 */
export function parseGbrainCallOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false };
  const attempts: string[] = [trimmed];
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (index > 0 && (char === "{" || char === "[")) {
      attempts.push(trimmed.slice(index));
    }
  }
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch {
      // fall through to the next attempt
    }
  }
  return { ok: false };
}

function truncateErrorMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > ERROR_MESSAGE_MAX_CHARS
    ? `${collapsed.slice(0, ERROR_MESSAGE_MAX_CHARS)}…`
    : collapsed;
}

function classifyExecError(error: unknown): { errorCode: MemoryProviderErrorCode; errorMessage: string } {
  const record = (error ?? {}) as Record<string, unknown>;
  const killed = record.killed === true;
  const signal = typeof record.signal === "string" ? record.signal : null;
  if (killed || signal !== null) {
    return { errorCode: "timeout", errorMessage: `gbrain call timed out (${signal ?? "killed"})` };
  }
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim().length > 0 ? `${message}: ${stderr}` : message;
  return { errorCode: "exec_failed", errorMessage: truncateErrorMessage(detail) };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSnippet(row: unknown): MemorySnippet | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const slug = readString(record.slug);
  if (!slug) return null;
  return {
    slug,
    text: readString(record.chunk_text) ?? "",
    title: readString(record.title),
    score: readNumber(record.score),
    stale: record.stale === true,
  };
}

function companySlugPrefix(companyId: string): string {
  return `paperclip/companies/${companyId}/`;
}

function isCompanyScopedSlug(slug: string, companyId: string): boolean {
  return slug.startsWith(companySlugPrefix(companyId));
}

function outOfScopeResult<T>(slug: string, companyId: string): MemoryProviderResult<T> {
  return {
    ok: false,
    errorCode: "exec_failed",
    errorMessage: `gbrain memory slug ${slug} is outside company ${companyId}`,
    latencyMs: 0,
  };
}

export function gbrainMemoryProvider(options: GbrainMemoryProviderOptions = {}): MemoryProvider {
  const execFileFn = options.execFileFn ?? defaultExecFile;
  const availabilityCacheMs = options.availabilityCacheMs ?? AVAILABILITY_CACHE_MS;
  let cachedResolution: { at: number; binPath: string | null } | null = null;

  async function resolveBin(): Promise<string | null> {
    const now = Date.now();
    if (cachedResolution && now - cachedResolution.at < availabilityCacheMs) {
      return cachedResolution.binPath;
    }
    const binPath = await resolveGbrainBinPath({
      binPath: options.binPath,
      env: options.env,
      accessFn: options.accessFn,
    });
    cachedResolution = { at: now, binPath };
    return binPath;
  }

  async function call(
    tool: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<MemoryProviderResult<unknown>> {
    const binPath = await resolveBin();
    if (!binPath) {
      return {
        ok: false,
        errorCode: "unavailable",
        errorMessage: "gbrain binary not found",
        latencyMs: 0,
      };
    }
    const startedAt = Date.now();
    try {
      const { stdout } = await execFileFn(binPath, ["call", tool, JSON.stringify(payload)], {
        timeout: timeoutMs,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
      });
      const latencyMs = Date.now() - startedAt;
      const parsed = parseGbrainCallOutput(stdout);
      if (!parsed.ok) {
        return {
          ok: false,
          errorCode: "bad_output",
          errorMessage: `gbrain ${tool} returned non-JSON output`,
          latencyMs,
        };
      }
      return { ok: true, value: parsed.value, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const { errorCode, errorMessage } = classifyExecError(error);
      return { ok: false, errorCode, errorMessage, latencyMs };
    }
  }

  return {
    key: "gbrain",

    async isAvailable(): Promise<boolean> {
      try {
        return (await resolveBin()) !== null;
      } catch {
        return false;
      }
    },

    async query(req: MemoryProviderQueryRequest): Promise<MemoryProviderResult<MemoryContextBundle>> {
      const result = await call(
        "query",
        {
          query: req.query,
          top_k: req.topK ?? MEMORY_BINDING_CONFIG_DEFAULTS.topK,
          expand: false,
        },
        req.timeoutMs ?? MEMORY_BINDING_CONFIG_DEFAULTS.queryTimeoutMs,
      );
      if (!result.ok) return result;
      const rows = Array.isArray(result.value) ? result.value : [];
      const snippets = rows
        .map((row) => toSnippet(row))
        .filter((snippet): snippet is MemorySnippet =>
          snippet !== null && isCompanyScopedSlug(snippet.slug, req.companyId),
        )
        .slice(0, req.topK ?? MEMORY_BINDING_CONFIG_DEFAULTS.topK);
      return { ok: true, value: { snippets }, latencyMs: result.latencyMs };
    },

    async capture(req: MemoryProviderCaptureRequest): Promise<MemoryProviderResult<{ slug: string }>> {
      if (!isCompanyScopedSlug(req.slug, req.companyId)) {
        return outOfScopeResult(req.slug, req.companyId);
      }
      const result = await call(
        "put_page",
        {
          slug: req.slug,
          content: req.content,
          type: req.type ?? "note",
          tags: req.tags ?? [],
        },
        req.timeoutMs ?? MEMORY_BINDING_CONFIG_DEFAULTS.captureTimeoutMs,
      );
      if (!result.ok) return result;
      const record = (result.value ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        value: { slug: readString(record.slug) ?? req.slug },
        latencyMs: result.latencyMs,
      };
    },

    async get(slug: string, opts?: { companyId?: string; timeoutMs?: number }): Promise<MemoryProviderResult<MemoryPage>> {
      if (opts?.companyId && !isCompanyScopedSlug(slug, opts.companyId)) {
        return outOfScopeResult(slug, opts.companyId);
      }
      const result = await call(
        "get_page",
        { slug },
        opts?.timeoutMs ?? MEMORY_BINDING_CONFIG_DEFAULTS.queryTimeoutMs,
      );
      if (!result.ok) return result;
      const record = (result.value ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        value: {
          slug: readString(record.slug) ?? slug,
          title: readString(record.title),
          content: readString(record.compiled_truth),
        },
        latencyMs: result.latencyMs,
      };
    },

    async forget(slug: string, opts?: { companyId?: string; timeoutMs?: number }): Promise<MemoryProviderResult<{ slug: string }>> {
      if (opts?.companyId && !isCompanyScopedSlug(slug, opts.companyId)) {
        return outOfScopeResult(slug, opts.companyId);
      }
      const result = await call(
        "delete_page",
        { slug },
        opts?.timeoutMs ?? MEMORY_BINDING_CONFIG_DEFAULTS.captureTimeoutMs,
      );
      if (!result.ok) return result;
      return { ok: true, value: { slug }, latencyMs: result.latencyMs };
    },
  };
}
