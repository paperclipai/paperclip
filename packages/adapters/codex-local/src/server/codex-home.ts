import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "instructions.md"] as const;
const SANITIZED_COPIED_FILES = ["config.toml"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;

/**
 * Remove `sandbox = "elevated"` (or `'elevated'` / bare `elevated`) from the
 * `[windows]` section of a Codex config.toml.  Codex's elevated sandbox
 * requires admin privileges which Paperclip-spawned processes don't have,
 * causing "Access is denied. (os error 5)" on Windows.
 *
 * If removing the sandbox key leaves an empty `[windows]` section, the whole
 * section header is removed as well.
 */
export function sanitizeConfigToml(content: string): string {
  // Match sandbox = "elevated" / 'elevated' / elevated anywhere in the file.
  // In practice this key only appears under [windows] in Codex config; a full
  // TOML-section-aware match would require a parser we don't carry.
  const sandboxRe = /^[ \t]*sandbox\s*=\s*(?:"elevated"|'elevated'|elevated)[ \t]*\r?\n?/gm;
  let result = content.replace(sandboxRe, "");

  // Remove [windows] header only if it's now empty (no non-blank lines before the next section or EOF)
  result = result.replace(
    /^([ \t]*\[windows\][ \t]*\r?\n)((?:[ \t]*\r?\n)*)(?=\[|$)/gm,
    (_match, _header, blanks) => blanks,
  );

  // Collapse runs of 3+ blank lines to 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

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
    await ensureCopiedFile(path.join(targetHome, name), source);
  }

  for (const name of SANITIZED_COPIED_FILES) {
    const target = path.join(targetHome, name);
    const source = path.join(sourceHome, name);
    const targetExists = await pathExists(target);
    const sourceExists = await pathExists(source);

    if (targetExists) {
      // Re-sanitize existing file (fixes managed homes created before this patch)
      const existing = await fs.readFile(target, "utf-8");
      const sanitized = sanitizeConfigToml(existing);
      if (sanitized !== existing) {
        await fs.writeFile(target, sanitized, "utf-8");
      }
    } else if (sourceExists) {
      // Copy and sanitize from source
      const raw = await fs.readFile(source, "utf-8");
      await ensureParentDir(target);
      await fs.writeFile(target, sanitizeConfigToml(raw), "utf-8");
    }
  }

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
