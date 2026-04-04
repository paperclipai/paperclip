import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const ISOLATED_MANAGED_CONFIG_SECTION_PATTERNS = [
  /^\[mcp_servers\.[^\]]+\]$/,
  /^\[plugins\..+\]$/,
  /^\[\[skills\.config\]\]$/,
];

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

function isRecoverableSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "UNKNOWN";
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function syncCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) return;
  if (existing?.isSymbolicLink()) {
    await fs.unlink(target);
  }
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

function shouldStripManagedConfigSection(header: string): boolean {
  return ISOLATED_MANAGED_CONFIG_SECTION_PATTERNS.some((pattern) => pattern.test(header));
}

function sanitizeManagedConfigToml(contents: string): string {
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = contents.endsWith("\n");
  const lines = contents.split(/\r?\n/);
  const kept: string[] = [];
  let skippingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isSectionHeader = trimmed.startsWith("[") && trimmed.endsWith("]");

    if (isSectionHeader) {
      skippingSection = shouldStripManagedConfigSection(trimmed);
      if (skippingSection) continue;
    }

    if (!skippingSection) {
      kept.push(line);
    }
  }

  let sanitized = kept.join(eol).replace(/(?:\r?\n){3,}/g, `${eol}${eol}`);
  sanitized = ensureManagedFeatureFlags(sanitized, eol);
  if (hasTrailingNewline && !sanitized.endsWith(eol)) {
    sanitized += eol;
  }
  return sanitized;
}

function ensureManagedFeatureFlags(contents: string, eol: string): string {
  const lines = contents.split(/\r?\n/);
  const next: string[] = [];
  let inFeatures = false;
  let injectedPluginsFlag = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isSectionHeader = trimmed.startsWith("[") && trimmed.endsWith("]");

    if (isSectionHeader && inFeatures && !injectedPluginsFlag) {
      next.push("plugins = false");
      injectedPluginsFlag = true;
    }

    if (isSectionHeader) {
      inFeatures = trimmed === "[features]";
    }

    if (inFeatures && /^plugins\s*=/.test(trimmed)) {
      next.push("plugins = false");
      injectedPluginsFlag = true;
      continue;
    }

    next.push(line);
  }

  if (inFeatures && !injectedPluginsFlag) {
    next.push("plugins = false");
    injectedPluginsFlag = true;
  }

  if (!next.some((line) => line.trim() === "[features]")) {
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push("[features]", "plugins = false");
  }

  return next.join(eol).replace(/(?:\r?\n){3,}/g, `${eol}${eol}`);
}

async function syncManagedConfigToml(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) return;
  if (existing?.isSymbolicLink()) {
    await fs.unlink(target);
  }

  const sanitized = sanitizeManagedConfigToml(await fs.readFile(source, "utf8"));
  await ensureParentDir(target);
  await fs.writeFile(target, sanitized, "utf8");
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
    const target = path.join(targetHome, name);
    try {
      await ensureSymlink(target, source);
    } catch (error) {
      if (!isRecoverableSymlinkError(error)) throw error;
      await syncCopiedFile(target, source);
      await onLog(
        "stdout",
        `[paperclip] Falling back to copying Codex shared file "${name}" into "${target}" after symlink failed (${(error as Error).message}).\n`,
      );
    }
  }

  for (const name of COPIED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    const target = path.join(targetHome, name);
    if (name === "config.toml") {
      await syncManagedConfigToml(target, source);
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
