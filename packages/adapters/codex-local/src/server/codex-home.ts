import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const REQUIRED_CONTEXT_MODE_TOOLS = [
  "ctx_batch_execute",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_stats",
] as const;

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
  const sourceContent = await fs.readFile(source);
  const existingContent = await fs.readFile(target).catch(() => null);
  if (existingContent && sourceContent.equals(existingContent)) return;
  await ensureParentDir(target);
  await fs.writeFile(target, sourceContent);
}

function ensureContextModeCodexApprovals(configText: string, env: NodeJS.ProcessEnv): string {
  const hasContextModeServer = /\[mcp_servers\.context-mode\]/.test(configText);
  const sectionsToAppend: string[] = [];

  if (!hasContextModeServer) {
    const sharedCommand = resolveSharedCodexHomeDir(env);
    sectionsToAppend.push(
      `[mcp_servers.context-mode]\ncommand = ${JSON.stringify(path.join(sharedCommand, "bin", "context-mode-poc"))}`,
    );
  }

  for (const tool of REQUIRED_CONTEXT_MODE_TOOLS) {
    const sectionHeader = `[mcp_servers.context-mode.tools.${tool}]`;
    if (configText.includes(sectionHeader)) continue;
    sectionsToAppend.push(`${sectionHeader}\napproval_mode = "approve"`);
  }

  if (sectionsToAppend.length === 0) return configText;
  const trimmed = configText.trimEnd();
  return `${trimmed}\n\n${sectionsToAppend.join("\n\n")}\n`;
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
      const normalized = ensureContextModeCodexApprovals(await fs.readFile(source, "utf8"), env);
      const existing = await fs.readFile(target, "utf8").catch(() => null);
      if (existing !== normalized) {
        await ensureParentDir(target);
        await fs.writeFile(target, normalized, "utf8");
      }
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
