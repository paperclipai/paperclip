import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const MANAGED_MCP_BLOCK_START = "# BEGIN PAPERCLIP MANAGED MCP";
const MANAGED_MCP_BLOCK_END = "# END PAPERCLIP MANAGED MCP";

export type ManagedCodexMcpGateway = {
  name: string;
  endpointPath: string;
  bearerToken: string;
};

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

export async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    // A previous Paperclip version copied this file into the managed home
    // instead of symlinking it. Codex refresh tokens rotate and are
    // single-use, so a stale copy fails with refresh_token_reused on the next
    // run (#5028). Replace the regular file with a symlink so the CLI follows
    // the live source. Safe to delete: target is always under the
    // Paperclip-managed company home, never the user's real ~/.codex.
    // Directories are left alone — `fs.unlink` would throw EISDIR on Unix
    // (and behave inconsistently on Windows). A directory at this path is not
    // a Paperclip-written stale copy and warrants operator inspection rather
    // than silent removal.
    if (existing.isDirectory()) return;
    await fs.unlink(target);
    await createExpectedSymlink(target, source);
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeMcpServerName(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function stripManagedMcpBlock(config: string): string {
  const start = config.indexOf(MANAGED_MCP_BLOCK_START);
  if (start < 0) return config.trimEnd();
  const end = config.indexOf(MANAGED_MCP_BLOCK_END, start);
  if (end < 0) return config.slice(0, start).trimEnd();
  return `${config.slice(0, start)}${config.slice(end + MANAGED_MCP_BLOCK_END.length)}`.trimEnd();
}

function readCodexMcpServerNames(config: string): Set<string> {
  const names = new Set<string>();
  for (const match of config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s#]+))\s*\]/gm)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name.trim());
  }
  return names;
}

function buildManagedMcpBlock(input: {
  gateways: ManagedCodexMcpGateway[];
  apiBaseUrl: string;
  existingNames: Set<string>;
}): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const lines = [
    MANAGED_MCP_BLOCK_START,
    "# Written by Paperclip for governed MCP gateway access. Do not edit this block by hand.",
  ];
  input.gateways.forEach((gateway, index) => {
    const baseName = sanitizeMcpServerName(gateway.name, `gateway-${index + 1}`);
    const directOverlap = input.existingNames.has(gateway.name) || input.existingNames.has(baseName);
    let managedName = directOverlap ? `paperclip-${baseName}` : baseName;
    let suffix = 2;
    while (usedNames.has(managedName) || input.existingNames.has(managedName)) {
      managedName = `paperclip-${baseName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(managedName);
    if (directOverlap) {
      warnings.push(
        `Found unmanaged Codex MCP server "${gateway.name}" overlapping a Paperclip-governed gateway; leaving the direct entry in place and adding managed gateway "${managedName}". Paperclip cannot enforce policies for that direct entry.`,
      );
    }
    const url = new URL(gateway.endpointPath, input.apiBaseUrl).toString();
    lines.push(
      "",
      `[mcp_servers.${tomlString(managedName)}]`,
      `url = ${tomlString(url)}`,
      `headers = { Authorization = ${tomlString(`Bearer ${gateway.bearerToken}`)} }`,
    );
  });
  lines.push(MANAGED_MCP_BLOCK_END);
  return { block: lines.join("\n"), warnings };
}

export async function writeManagedCodexMcpConfig(input: {
  codexHome: string;
  apiBaseUrl: string;
  gateways: ManagedCodexMcpGateway[];
}): Promise<{ configPath: string; warnings: string[] }> {
  const configPath = path.join(input.codexHome, "config.toml");
  await fs.mkdir(input.codexHome, { recursive: true });
  const existing = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const unmanagedConfig = stripManagedMcpBlock(existing);
  const { block, warnings } = buildManagedMcpBlock({
    gateways: input.gateways,
    apiBaseUrl: input.apiBaseUrl,
    existingNames: readCodexMcpServerNames(unmanagedConfig),
  });
  const next = `${unmanagedConfig}${unmanagedConfig ? "\n\n" : ""}${block}\n`;
  await fs.writeFile(configPath, next, { mode: 0o600 });
  return { configPath, warnings };
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

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null } = {},
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
