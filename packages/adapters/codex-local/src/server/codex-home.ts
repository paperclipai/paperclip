import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const TOML_SECTION_RE = /^\[[^\]]+\]\s*$/gm;
const MCP_SERVER_SECTION_RE = /^\[mcp_servers\.(?:"([^"]+)"|([^\]]+))\]\s*$/gm;

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
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return;

  await fs.unlink(target);
  await fs.symlink(source, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

function parseMcpServerBlocks(toml: string): Map<string, string> {
  const sectionStarts: number[] = [];
  TOML_SECTION_RE.lastIndex = 0;
  for (let header = TOML_SECTION_RE.exec(toml); header; header = TOML_SECTION_RE.exec(toml)) {
    sectionStarts.push(header.index);
  }

  const output = new Map<string, string>();
  MCP_SERVER_SECTION_RE.lastIndex = 0;
  for (let match = MCP_SERVER_SECTION_RE.exec(toml); match; match = MCP_SERVER_SECTION_RE.exec(toml)) {
    const serverName = (match[1] ?? match[2] ?? "").trim();
    if (!serverName) continue;
    const start = match.index;
    const nextSectionStart = sectionStarts.find((candidate) => candidate > start) ?? toml.length;
    const block = toml.slice(start, nextSectionStart).trimEnd();
    if (!block) continue;
    output.set(serverName, block);
  }

  return output;
}

function mergeMissingMcpServerBlocks(
  targetToml: string,
  sourceToml: string,
): { mergedToml: string; addedNames: string[] } {
  const sourceBlocks = parseMcpServerBlocks(sourceToml);
  if (sourceBlocks.size === 0) {
    return { mergedToml: targetToml, addedNames: [] };
  }

  const targetBlocks = parseMcpServerBlocks(targetToml);
  const blocksToAdd: string[] = [];
  const addedNames: string[] = [];
  for (const [name, block] of sourceBlocks.entries()) {
    if (targetBlocks.has(name)) continue;
    blocksToAdd.push(block);
    addedNames.push(name);
  }

  if (blocksToAdd.length === 0) {
    return { mergedToml: targetToml, addedNames: [] };
  }

  const base = targetToml.trimEnd();
  const mergedToml = `${base}\n\n${blocksToAdd.join("\n\n")}\n`;
  return { mergedToml, addedNames };
}

async function ensureConfigTomlWithMcpServers(
  target: string,
  source: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.copyFile(source, target);
    return;
  }
  if (!existing.isFile()) return;

  const [sourceToml, targetToml] = await Promise.all([
    fs.readFile(source, "utf8").catch(() => null),
    fs.readFile(target, "utf8").catch(() => null),
  ]);
  if (sourceToml == null || targetToml == null) return;

  const { mergedToml, addedNames } = mergeMissingMcpServerBlocks(targetToml, sourceToml);
  if (addedNames.length === 0) return;

  await fs.writeFile(target, mergedToml, "utf8");
  await onLog(
    "stdout",
    `[paperclip] Synced missing Codex MCP server blocks (${addedNames.join(", ")}) into "${target}".\n`,
  );
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  for (const name of SYMLINKED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, name), source);
  }

  for (const name of COPIED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    const target = path.join(targetHome, name);
    if (name === "config.toml") {
      await ensureConfigTomlWithMcpServers(target, source, onLog);
      continue;
    }
    await ensureCopiedFile(target, source);
  }

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
