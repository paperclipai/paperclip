import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const REDACTED_VALUE = "***REDACTED***";
const SENSITIVE_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie)/i;
const JWT_TEXT_RE = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g;
const BEARER_TEXT_RE = /\bBearer\s+[^\s"',}]+/gi;
const SHELL_EXPORT_RE = /^(\s*(?:export\s+)?)(([A-Za-z_][A-Za-z0-9_]*))(=.*)$/;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactText(text: string): string {
  let redacted = text.replace(BEARER_TEXT_RE, `Bearer ${REDACTED_VALUE}`);
  redacted = redacted.replace(JWT_TEXT_RE, REDACTED_VALUE);

  const lines = redacted.split(/\r?\n/);
  let changed = false;
  const rewritten = lines.map((line) => {
    const match = line.match(SHELL_EXPORT_RE);
    if (!match) return line;
    const [, prefix, key] = match;
    if (!SENSITIVE_KEY_RE.test(key)) return line;
    changed = true;
    return `${prefix}${key}=${REDACTED_VALUE}`;
  });
  return changed ? rewritten.join("\n") : redacted;
}

function sanitizeArtifactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeArtifactValue(entry));
  if (!isPlainObject(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      sanitized[key] = REDACTED_VALUE;
      continue;
    }
    sanitized[key] = sanitizeArtifactValue(entry);
  }
  return sanitized;
}

async function chmodSafe(target: string, mode: number): Promise<void> {
  await fs.chmod(target, mode).catch(() => undefined);
}

async function scrubJsonlFile(target: string): Promise<boolean> {
  const original = await fs.readFile(target, "utf8");
  const endsWithNewline = original.endsWith("\n");
  let changed = false;
  const scrubbed = original
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      try {
        const parsed = JSON.parse(line) as unknown;
        const sanitized = sanitizeArtifactValue(parsed);
        const rewritten = JSON.stringify(sanitized);
        if (rewritten !== line) changed = true;
        return rewritten;
      } catch {
        const rewritten = redactText(line);
        if (rewritten !== line) changed = true;
        return rewritten;
      }
    })
    .join("\n");
  if (!changed) return false;
  await fs.writeFile(target, endsWithNewline ? `${scrubbed}\n` : scrubbed, "utf8");
  return true;
}

async function scrubShellSnapshotFile(target: string): Promise<boolean> {
  const original = await fs.readFile(target, "utf8");
  const rewritten = redactText(original);
  if (rewritten === original) return false;
  await fs.writeFile(target, rewritten, "utf8");
  return true;
}

async function scrubArtifactFile(target: string): Promise<boolean> {
  if (target.endsWith(".jsonl")) return scrubJsonlFile(target);
  if (target.endsWith(".sh")) return scrubShellSnapshotFile(target);
  return false;
}

async function scrubArtifactTree(root: string): Promise<number> {
  let scrubbedFiles = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await chmodSafe(target, 0o700);
        queue.push(target);
        continue;
      }
      await chmodSafe(target, 0o600);
      if (await scrubArtifactFile(target)) scrubbedFiles += 1;
    }
  }
  return scrubbedFiles;
}

export async function scrubCodexHomeArtifacts(
  codexHome: string,
  onLog?: AdapterExecutionContext["onLog"],
): Promise<void> {
  await chmodSafe(codexHome, 0o700);
  let scrubbedFiles = 0;
  for (const subdir of ["sessions", "shell_snapshots"]) {
    const target = path.join(codexHome, subdir);
    if (!(await pathExists(target))) continue;
    scrubbedFiles += await scrubArtifactTree(target);
  }
  if (scrubbedFiles > 0 && onLog) {
    await onLog("stdout", `[paperclip] Scrubbed ${scrubbedFiles} Codex artifact file(s) under "${codexHome}".\n`);
  }
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

  await chmodSafe(targetHome, 0o700);
  await scrubCodexHomeArtifacts(targetHome);

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
