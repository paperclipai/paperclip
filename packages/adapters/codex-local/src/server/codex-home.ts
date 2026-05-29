import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import {
  loadMcpRegistry,
  type McpRegistry,
  renderCodexMcpToml,
  resolveMcpAllowlist,
} from "@paperclipai/adapter-utils/mcp-allowlist";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_MCP_REGISTRY_ROOT = "/Users/cassio/mcp-server/_paperclip";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "codex-home")
    : path.resolve(instanceRoot, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  if (await isExpectedSymlink(target, source)) return;

  await fs.unlink(target);
  await createExpectedSymlink(target, source);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "auth.json");
  await fs.rm(target, { force: true });
  await fs.writeFile(target, JSON.stringify({ OPENAI_API_KEY: apiKey }), { mode: 0o600 });
}

function resolveMcpRegistryRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.PAPERCLIP_MCP_REGISTRY_ROOT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MCP_REGISTRY_ROOT;
}

function resolveRunMcpScript(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.PAPERCLIP_MCP_RUN_SCRIPT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Strips all `[mcp_servers.<id>]` sections from a TOML string. A section
 * runs from its header line until either EOF or the next top-level header
 * line. We don't need a full TOML parser here because the codex config
 * surface we care about is well-defined: codex CLI reads `mcp_servers.*`
 * tables and any non-mcp section is copied through untouched.
 */
export function stripCodexMcpSections(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      const headerMatch = trimmed.match(/^\[(\[?)([^\]]+)/);
      if (headerMatch && /^mcp_servers\.[A-Za-z0-9_.\-]+/.test(headerMatch[2].trim())) {
        skipping = true;
        continue;
      }
      // any other section header ends the skip mode
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  // Trim trailing empty lines but keep one final newline.
  while (out.length > 0 && out[out.length - 1].trim() === "") {
    out.pop();
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/**
 * Applies the per-agent `MCP_LIST` allowlist to `$CODEX_HOME/config.toml`.
 *
 * - Reads existing `config.toml` (may not exist).
 * - Strips every `[mcp_servers.*]` section.
 * - Appends the rendered fragments for ids in the allowlist.
 *
 * Returns notes for logging, or `null` when MCP_LIST is empty/unset (in
 * which case the file is left untouched).
 *
 * Fail-closed: throws on resolution errors so the caller never spawns the
 * CLI with a partial / silently-broken MCP set.
 */
export async function applyMcpListToCodexHome(input: {
  home: string;
  env: NodeJS.ProcessEnv;
  registry?: McpRegistry;
}): Promise<{ notes: string[] } | null> {
  const raw = input.env.MCP_LIST;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const registry = input.registry ?? (await loadMcpRegistry(resolveMcpRegistryRoot(input.env)));
  const result = resolveMcpAllowlist({
    rawAllowlist: raw,
    registry,
    runMcpScript: resolveRunMcpScript(input.env),
  });
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => `[${e.kind}] ${e.message}`).join("; ");
    throw new Error(`codex_local: MCP_LIST validation failed — ${messages}`);
  }
  const tomlPath = path.join(input.home, "config.toml");
  let existing = "";
  try {
    existing = await fs.readFile(tomlPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
  }
  const base = stripCodexMcpSections(existing);
  const rendered = renderCodexMcpToml(result.resolved);
  const next = rendered.length > 0
    ? `${base}${base.length > 0 && !base.endsWith("\n\n") ? "\n" : ""}${rendered}\n`
    : base;
  // Avoid writing if nothing actually changed; this keeps the file's mtime
  // stable for callers that diff config artifacts.
  if (next !== existing) {
    await fs.mkdir(input.home, { recursive: true });
    await fs.writeFile(tomlPath, next, "utf8");
  }
  return {
    notes: [
      `Applied MCP_LIST allowlist to ${tomlPath}: rendered ${result.resolved.length} mcp_servers entries.`,
    ],
  };
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null; registry?: McpRegistry } = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true });

  // If a previous run wrote an apikey-mode auth.json (regular file) and this
  // run has no apiKey, remove it so the chatgpt-mode symlink can be restored.
  // Without this cleanup, ensureSymlink bails on a non-symlink and Codex keeps
  // authenticating with the stale key after it is removed from configuration.
  if (!apiKey && seedFromShared) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      await fs.rm(authPath, { force: true });
    }
  }

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureSymlink(path.join(targetHome, name), source);
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }

  return targetHome;
}
