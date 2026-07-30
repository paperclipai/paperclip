import { existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (value.startsWith("#")) {
      entries[key] = "";
      continue;
    }

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

type WorktreeEnvBootstrapResult =
  | { envPath: null; missingEnv: false }
  | { envPath: string; missingEnv: true }
  | { envPath: string; missingEnv: false };

export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.resolve(rootDir, ".paperclip", ".env");
}

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Decide whether the worktree's own env entry has to outrank an inherited one.
 *
 * A dev runner started from a shell that already exported the canonical
 * instance's `PAPERCLIP_CONFIG` would otherwise keep pointing at that config
 * while the rest of the run uses this worktree's paths — the same split
 * between destination and contents that let worktree repair rewrite a foreign
 * config file. Only an inherited value from outside this checkout is replaced,
 * and only by a value that points back inside it.
 */
function shouldOverrideInheritedEntry(
  key: string,
  inheritedValue: string,
  worktreeValue: string,
  rootDir: string,
): boolean {
  if (key !== "PAPERCLIP_CONFIG") return false;
  if (isPathInside(resolveHomeAwarePath(inheritedValue), rootDir)) return false;
  return isPathInside(resolveHomeAwarePath(worktreeValue), rootDir);
}

function resolveDefaultWorktreeHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(expandHomePrefix(env.PAPERCLIP_WORKTREES_DIR?.trim() || "~/.paperclip-worktrees"));
}

function repairStaleMigratedWorktreeEnvEntries(
  rootDir: string,
  entries: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const localConfigPath = path.resolve(rootDir, ".paperclip", "config.json");
  const configuredPath = entries.PAPERCLIP_CONFIG?.trim();
  if (!configuredPath) return entries;

  const resolvedConfiguredPath = resolveHomeAwarePath(configuredPath);
  const staleConfigPath =
    resolvedConfiguredPath !== localConfigPath &&
    !existsSync(resolvedConfiguredPath) &&
    existsSync(localConfigPath);
  if (!staleConfigPath) return entries;

  const homeDir = resolveDefaultWorktreeHome(env);
  return {
    ...entries,
    PAPERCLIP_HOME: homeDir,
    PAPERCLIP_CONFIG: localConfigPath,
    PAPERCLIP_CONTEXT: path.resolve(homeDir, "context.json"),
  };
}

export function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeEnvBootstrapResult {
  if (!isLinkedGitWorktreeCheckout(rootDir)) {
    return {
      envPath: null,
      missingEnv: false,
    };
  }

  const envPath = resolveWorktreeEnvFilePath(rootDir);
  if (!existsSync(envPath)) {
    return {
      envPath,
      missingEnv: true,
    };
  }

  const entries = repairStaleMigratedWorktreeEnvEntries(
    rootDir,
    parseEnvFile(readFileSync(envPath, "utf8")),
    env,
  );
  for (const [key, value] of Object.entries(entries)) {
    const inherited = env[key];
    if (typeof inherited === "string" && inherited.trim().length > 0) {
      if (!shouldOverrideInheritedEntry(key, inherited, value, rootDir)) continue;
    }
    env[key] = value;
  }

  return {
    envPath,
    missingEnv: false,
  };
}
